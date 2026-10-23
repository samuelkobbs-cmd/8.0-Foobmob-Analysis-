
const API_BASE = "https://api.football-data.org/v4";

const COMPETITIONS = [
  "BSA", "ELC", "PL", "CL", "EC", "FL1",
  "BL1", "SA", "DED", "PPL", "CLI", "PD", "WC"
];

function poissonProbability(lambda, goals) {
  if (lambda <= 0) return goals === 0 ? 1 : 0;

  let probability = Math.exp(-lambda);

  for (let i = 1; i <= goals; i++) {
    probability *= lambda / i;
  }

  return probability;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function poissonLogLoss(lambda, actualGoals) {
  // Negative log probability of the observed goal count.
  // Clamp the probability to avoid log(0).
  const probability = Math.max(
    poissonProbability(lambda, actualGoals),
    1e-12
  );

  return -Math.log(probability);
}

function fitModel(history) {
  const teams = {};

  let totalHome = 0;
  let totalAway = 0;

  for (const match of history) {
    const home = match.homeTeam.name;
    const away = match.awayTeam.name;
    const hg = match.score.fullTime.home;
    const ag = match.score.fullTime.away;

    if (hg == null || ag == null) continue;

    totalHome += hg;
    totalAway += ag;

    if (!teams[home]) {
      teams[home] = { homeGF: 0, homeGA: 0, homeN: 0, awayGF: 0, awayGA: 0, awayN: 0 };
    }

    if (!teams[away]) {
      teams[away] = { homeGF: 0, homeGA: 0, homeN: 0, awayGF: 0, awayGA: 0, awayN: 0 };
    }

    teams[home].homeGF += hg;
    teams[home].homeGA += ag;
    teams[home].homeN += 1;

    teams[away].awayGF += ag;
    teams[away].awayGA += hg;
    teams[away].awayN += 1;
  }

  const n = history.length;
  if (!n) return null;

  const homeRate = totalHome / n;
  const awayRate = totalAway / n;
  const overallRate = (totalHome + totalAway) / (2 * n);

  for (const team of Object.values(teams)) {
    team.homeAttack = team.homeN
      ? (team.homeGF / team.homeN) / (homeRate || 1)
      : 1;

    team.homeDefence = team.homeN
      ? (team.homeGA / team.homeN) / (awayRate || 1)
      : 1;

    team.awayAttack = team.awayN
      ? (team.awayGF / team.awayN) / (awayRate || 1)
      : 1;

    team.awayDefence = team.awayN
      ? (team.awayGA / team.awayN) / (homeRate || 1)
      : 1;
  }

  return { teams, homeRate, awayRate, overallRate };
}

function estimateGoals(model, homeName, awayName) {
  const home = model.teams[homeName];
  const away = model.teams[awayName];

  if (!home || !away) {
    return {
      home: model.homeRate,
      away: model.awayRate
    };
  }

  return {
    home: Math.max(
      0.05,
      model.homeRate * home.homeAttack * away.awayDefence
    ),
    away: Math.max(
      0.05,
      model.awayRate * away.awayAttack * home.homeDefence
    )
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Use GET for this endpoint." });
  }

  const competition = String(req.query.competition || "PL").toUpperCase();
  const requestedMatches = Number(req.query.matches || 100);

  if (!COMPETITIONS.includes(competition)) {
    return res.status(400).json({
      error: "Unsupported competition code.",
      supportedCompetitions: COMPETITIONS
    });
  }

  if (!Number.isInteger(requestedMatches) ||
      requestedMatches < 30 ||
      requestedMatches > 300) {
    return res.status(400).json({
      error: "matches must be an integer between 30 and 300."
    });
  }

  const token = process.env.FOOTBALL_DATA_API_KEY;

  if (!token) {
    return res.status(500).json({
      error: "FOOTBALL_DATA_API_KEY is not configured."
    });
  }

  try {
    const currentYear = new Date().getUTCFullYear();
    const matches = [];

    // Fetch completed matches across recent calendar-year ranges.
    for (let offset = 0; offset < 3; offset++) {
      const year = currentYear - offset;
      const url = `${API_BASE}/competitions/${competition}/matches?dateFrom=${year}-01-01&dateTo=${year}-12-31&status=FINISHED`;

      const response = await fetch(url, {
        headers: { "X-Auth-Token": token }
      });

      if (!response.ok) {
        return res.status(response.status).json({
          error: "Football data provider request failed.",
          providerStatus: response.status,
          year
        });
      }

      const data = await response.json();
      matches.push(...(data.matches || []));
    }

    const uniqueMatches = Array.from(
      new Map(matches.map(match => [match.id, match])).values()
    )
      .filter(match =>
        match.status === "FINISHED" &&
        match.score?.fullTime?.home != null &&
        match.score?.fullTime?.away != null &&
        match.homeTeam?.name &&
        match.awayTeam?.name &&
        match.utcDate
      )
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    if (uniqueMatches.length < 31) {
      return res.status(200).json({
        competition,
        message: "Not enough completed matches for a chronological backtest.",
        matchesFound: uniqueMatches.length,
        minimumRequired: 31
      });
    }

    // Keep the newest requested number of matches, in date order.
    const selected = uniqueMatches.slice(-requestedMatches);
    const predictions = [];

    // Every prediction uses only matches played before the target match.
    for (let i = 0; i < selected.length; i++) {
      const target = selected[i];

      const history = uniqueMatches.filter(
        match => new Date(match.utcDate) < new Date(target.utcDate)
      );

      if (history.length < 30) continue;

      const model = fitModel(history);
      if (!model) continue;

      const actualHome = target.score.fullTime.home;
      const actualAway = target.score.fullTime.away;
      const estimated = estimateGoals(
        model,
        target.homeTeam.name,
        target.awayTeam.name
      );

      predictions.push({
        date: target.utcDate,
        homeTeam: target.homeTeam.name,
        awayTeam: target.awayTeam.name,
        actual: { home: actualHome, away: actualAway },
        expected: {
          home: Number(estimated.home.toFixed(3)),
          away: Number(estimated.away.toFixed(3))
        },
        baseline: {
          home: Number(model.homeRate.toFixed(3)),
          away: Number(model.awayRate.toFixed(3))
        }
      });
    }

    const modelErrors = [];
    const baselineErrors = [];
    const modelLosses = [];
    const baselineLosses = [];

    for (const prediction of predictions) {
      for (const side of ["home", "away"]) {
        const actual = prediction.actual[side];
        const predicted = prediction.expected[side];
        const baseline = prediction.baseline[side];

        modelErrors.push(Math.abs(actual - predicted));
        baselineErrors.push(Math.abs(actual - baseline));

        modelLosses.push(poissonLogLoss(predicted, actual));
        baselineLosses.push(poissonLogLoss(baseline, actual));
      }
    }

    return res.status(200).json({
      competition,
      method: "Chronological expanding-window Poisson backtest",
      matchesAvailable: uniqueMatches.length,
      matchesEvaluated: predictions.length,
      firstTestMatch: predictions[0]?.date || null,
      lastTestMatch: predictions[predictions.length - 1]?.date || null,
      metrics: {
        poissonModel: {
          meanAbsoluteError: mean(modelErrors),
          meanPoissonLogLoss: mean(modelLosses)
        },
        leagueAverageBaseline: {
          meanAbsoluteError: mean(baselineErrors),
          meanPoissonLogLoss: mean(baselineLosses)
        }
      },
      note: "Exploratory historical evaluation, not a guarantee of future accuracy. Team rates are simple averages without time weighting."
    });
  } catch (error) {
    return res.status(500).json({
      error: "Backtest failed.",
      details: error.message
    });
  }
}

