
const API_BASE = "https://api.football-data.org/v4";
const SHRINKAGE_MATCHES = 6;

const ALLOWED_CODES = new Set([
  "BSA", "ELC", "PL", "CL", "EC", "FL1", "BL1",
  "SA", "DED", "PPL", "CLI", "PD", "WC"
]);

function validMatch(match) {
  const home = match.score?.fullTime?.home;
  const away = match.score?.fullTime?.away;

  return (
    match.status === "FINISHED" &&
    match.homeTeam?.id != null &&
    match.awayTeam?.id != null &&
    Number.isInteger(home) &&
    Number.isInteger(away) &&
    home >= 0 &&
    away >= 0
  );
}

function poissonLogProbability(goals, lambda) {
  lambda = Math.max(0.05, lambda);

  let logFactorial = 0;
  for (let i = 2; i <= goals; i++) {
    logFactorial += Math.log(i);
  }

  return goals * Math.log(lambda) - lambda - logFactorial;
}

function createTeamStats(matches) {
  const teams = new Map();

  function getTeam(id) {
    if (!teams.has(id)) {
      teams.set(id, {
        homePlayed: 0,
        awayPlayed: 0,
        homeScored: 0,
        homeConceded: 0,
        awayScored: 0,
        awayConceded: 0
      });
    }
    return teams.get(id);
  }

  let homeGoals = 0;
  let awayGoals = 0;

  for (const match of matches) {
    const home = getTeam(match.homeTeam.id);
    const away = getTeam(match.awayTeam.id);
    const hg = match.score.fullTime.home;
    const ag = match.score.fullTime.away;

    home.homePlayed++;
    home.homeScored += hg;
    home.homeConceded += ag;

    away.awayPlayed++;
    away.awayScored += ag;
    away.awayConceded += hg;

    homeGoals += hg;
    awayGoals += ag;
  }

  return {
    teams,
    leagueHome: matches.length ? homeGoals / matches.length : 1.35,
    leagueAway: matches.length ? awayGoals / matches.length : 1.10
  };
}

function smoothedFactor(teamRate, leagueRate, games) {
  if (!games || !leagueRate) return 1;

  const rawFactor = teamRate / leagueRate;
  const weight = games / (games + SHRINKAGE_MATCHES);

  return 1 + (rawFactor - 1) * weight;
}

function predict(homeId, awayId, stats) {
  const home = stats.teams.get(homeId);
  const away = stats.teams.get(awayId);

  const homeAttack = home
    ? smoothedFactor(home.homeScored / Math.max(1, home.homePlayed), stats.leagueHome, home.homePlayed)
    : 1;

  const homeDefence = home
    ? smoothedFactor(home.homeConceded / Math.max(1, home.homePlayed), stats.leagueAway, home.homePlayed)
    : 1;

  const awayAttack = away
    ? smoothedFactor(away.awayScored / Math.max(1, away.awayPlayed), stats.leagueAway, away.awayPlayed)
    : 1;

  const awayDefence = away
    ? smoothedFactor(away.awayConceded / Math.max(1, away.awayPlayed), stats.leagueHome, away.awayPlayed)
    : 1;

  return {
    home: Math.max(0.05, stats.leagueHome * homeAttack * awayDefence),
    away: Math.max(0.05, stats.leagueAway * awayAttack * homeDefence)
  };
}

function calculateMetrics(results) {
  let absoluteError = 0;
  let logLoss = 0;
  let observations = 0;

  for (const result of results) {
    absoluteError +=
      Math.abs(result.predicted.home - result.actual.home) +
      Math.abs(result.predicted.away - result.actual.away);

    logLoss -=
      poissonLogProbability(result.actual.home, result.predicted.home) +
      poissonLogProbability(result.actual.away, result.predicted.away);

    observations += 2;
  }

  return {
    meanAbsoluteError: Number((absoluteError / observations).toFixed(4)),
    meanPoissonLogLoss: Number((logLoss / results.length).toFixed(4))
  };
}

export default async function handler(req, res) {
  try {
    const competition = String(req.query.competition || "PL").toUpperCase();
    const requestedMatches = Number(req.query.matches || 100);

    if (!ALLOWED_CODES.has(competition)) {
      return res.status(400).json({ error: "Unsupported competition code." });
    }

    if (!Number.isInteger(requestedMatches) || requestedMatches < 30 || requestedMatches > 300) {
      return res.status(400).json({ error: "matches must be an integer between 30 and 300." });
    }

    const apiKey = process.env.FOOTBALL_DATA_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "FOOTBALL_DATA_API_KEY is not configured." });
    }

    const url = `${API_BASE}/competitions/${competition}/matches?status=FINISHED`;

    const response = await fetch(url, {
      headers: { "X-Auth-Token": apiKey }
    });

    if (!response.ok) {
      const providerMessage = await response.text();

      return res.status(response.status === 403 ? 403 : 502).json({
        error: "Football data provider request failed.",
        competition,
        providerStatus: response.status,
        providerMessage
      });
    }

    const payload = await response.json();

    const matches = (payload.matches || [])
      .filter(validMatch)
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    if (matches.length < 31) {
      return res.status(422).json({
        error: "Not enough completed matches for backtesting.",
        competition,
        matchesAvailable: matches.length,
        minimumRequired: 31
      });
    }

    const testCount = Math.min(requestedMatches, matches.length - 30);
    const firstTestIndex = matches.length - testCount;
    const results = [];
    const baselineResults = [];

    for (let index = firstTestIndex; index < matches.length; index++) {
      const history = matches.slice(0, index);
      const target = matches[index];

      if (history.length < 30) continue;

      const stats = createTeamStats(history);

      const modelPrediction = predict(
        target.homeTeam.id,
        target.awayTeam.id,
        stats
      );

      const baselinePrediction = {
        home: Math.max(0.05, stats.leagueHome),
        away: Math.max(0.05, stats.leagueAway)
      };

      const actual = {
        home: target.score.fullTime.home,
        away: target.score.fullTime.away
      };

      results.push({ predicted: modelPrediction, actual });
      baselineResults.push({ predicted: baselinePrediction, actual });
    }

    if (!results.length) {
      return res.status(422).json({
        error: "No matches could be evaluated.",
        matchesAvailable: matches.length
      });
    }

    const season = matches.find(match => match.season)?.season || null;

    return res.status(200).json({
      competition,
      season,
      method: "Regularised home/away Poisson model with chronological expanding-window backtest",
      modelVersion: "Poisson v2",
      shrinkageMatches: SHRINKAGE_MATCHES,
      matchesAvailable: matches.length,
      matchesEvaluated: results.length,
      firstTestMatch: matches[firstTestIndex]?.utcDate || null,
      lastTestMatch: matches[matches.length - 1]?.utcDate || null,
      metrics: {
        poissonModel: calculateMetrics(results),
        leagueAverageBaseline: calculateMetrics(baselineResults)
      },
      note: "Exploratory current-season evaluation. Lower MAE and lower Poisson log loss are better. Each prediction uses only earlier completed matches. Results do not guarantee future accuracy."
    });
  } catch (error) {
    return res.status(500).json({
      error: "Backtest failed.",
      message: error.message
    });
  }
}
