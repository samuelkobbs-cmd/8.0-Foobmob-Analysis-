
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

function poissonLogLoss(lambda, actualGoals) {
  const probability = Math.max(
    poissonProbability(lambda, actualGoals),
    1e-12
  );

  return -Math.log(probability);
}

function mean(values) {
  if (!values.length) return null;

  return values.reduce((sum, value) => sum + value, 0) /
    values.length;
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

    if (!teams[home]) {
      teams[home] = {
        homeGF: 0, homeGA: 0, homeN: 0,
        awayGF: 0, awayGA: 0, awayN: 0
      };
    }

    if (!teams[away]) {
      teams[away] = {
        homeGF: 0, homeGA: 0, homeN: 0,
        awayGF: 0, awayGA: 0, awayN: 0
      };
    }

    teams[home].homeGF += hg;
    teams[home].homeGA += ag;
    teams[home].homeN++;

    teams[away].awayGF += ag;
    teams[away].awayGA += hg;
    teams[away].awayN++;

    totalHome += hg;
    totalAway += ag;
  }

  const n = history.length;

  if (!n) return null;

  const homeRate = totalHome / n;
  const awayRate = totalAway / n;

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

  return { teams, homeRate, awayRate };
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
    return res.status(405).json({
      error: "Use GET for this endpoint."
    });
  }

  const competition = String(
    req.query.competition || "PL"
  ).toUpperCase();

  const requestedMatches = Number(req.query.matches || 100);

  if (!COMPETITIONS.includes(competition)) {
    return res.status(400).json({
      error: "Unsupported competition code.",
      supportedCompetitions: COMPETITIONS
    });
  }

  if (
    !Number.isInteger(requestedMatches) ||
    requestedMatches < 30 ||
    requestedMatches > 300
  ) {
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
    // No season parameter: request the provider's default
    // current season, rather than restricted historical years.
    const url =
      `${API_BASE}/competitions/${competition}/matches?status=FINISHED`;

    const response = await fetch(url, {
      headers: {
        "X-Auth-Token": token
      }
    });

    if (!response.ok) {
      const providerMessage = await response.text();

      return res.status(502).json({
        error: "Current-season data request failed.",
        competition,
        providerStatus: response.status,
        providerMessage
      });
    }

    const data = await response.json();

    const uniqueMatches = Array.from(
      new Map(
        (data.matches || []).map(match => [match.id, match])
      ).values()
    )
      .filter(match =>
        match.status === "FINISHED" &&
        match.score?.fullTime?.home != null &&
        match.score?.fullTime?.away != null &&
        match.homeTeam?.name &&
        match.awayTeam?.name &&
        match.utcDate
      )
      .sort(
        (a, b) =>
          new Date(a.utcDate) - new Date(b.utcDate)
      );

    if (uniqueMatches.length < 31) {
      return res.status(200).json({
        competition,
        season: data.matches?.[0]?.season || null,
        message:
          "Not enough completed current-season matches yet.",
        matchesFound: uniqueMatches.length,
        matchesRequired: 31,
        explanation:
          "The model needs at least 30 earlier matches before evaluating a later match."
      });
    }

    const selected = uniqueMatches.slice(-requestedMatches);
    const predictions = [];

    // Each match is evaluated using only earlier matches.
    for (const target of selected) {
      const targetDate = new Date(target.utcDate);

      const history = uniqueMatches.filter(
        match => new Date(match.utcDate) < targetDate
      );

      if (history.length < 30) continue;

      const model = fitModel(history);

      if (!model) continue;

      const actualHome = target.score.fullTime.home;
      const actualAway = target.score.fullTime.away;

      const expected = estimateGoals(
        model,
        target.homeTeam.name,
        target.awayTeam.name
      );

      predictions.push({
        date: target.utcDate,
        homeTeam: target.homeTeam.name,
        awayTeam: target.awayTeam.name,

        actual: {
          home: actualHome,
          away: actualAway
        },

        expected: {
          home: Number(expected.home.toFixed(3)),
          away: Number(expected.away.toFixed(3))
        },

        baseline: {
          home: Number(model.homeRate.toFixed(3)),
          away: Number(model.awayRate.toFixed(3))
        },

        trainingMatches: history.length
      });
    }

    if (!predictions.length) {
      return res.status(200).json({
        competition,
        message: "No matches qualified for evaluation.",
        matchesAvailable: uniqueMatches.length
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

        modelLosses.push(
          poissonLogLoss(predicted, actual)
        );

        baselineLosses.push(
          poissonLogLoss(baseline, actual)
        );
      }
    }

    return res.status(200).json({
      competition,

      season: data.matches?.[0]?.season || null,

      method:
        "Current-season chronological expanding-window Poisson backtest",

      matchesAvailable: uniqueMatches.length,
      matchesEvaluated: predictions.length,

      firstTestMatch: predictions[0].date,

      lastTestMatch:
        predictions[predictions.length - 1].date,

      metrics: {
        poissonModel: {
          meanAbsoluteError: Number(
            mean(modelErrors).toFixed(4)
          ),
          meanPoissonLogLoss: Number(
            mean(modelLosses).toFixed(4)
          )
        },

        leagueAverageBaseline: {
          meanAbsoluteError: Number(
            mean(baselineErrors).toFixed(4)
          ),
          meanPoissonLogLoss: Number(
            mean(baselineLosses).toFixed(4)
          )
        }
      },

      note:
        "Exploratory current-season historical evaluation. Lower MAE and lower Poisson log loss are better. Results do not guarantee future accuracy."
    });

  } catch (error) {
    return res.status(500).json({
      error: "Backtest failed.",
      details: error.message
    });
  }
}
