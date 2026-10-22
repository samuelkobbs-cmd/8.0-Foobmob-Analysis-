
export default async function handler(req, res) {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Football API key is not configured."
    });
  }

  const code = String(req.query?.competition || "PL")
    .trim()
    .toUpperCase();

  const allowedCodes = [
    "BSA", "ELC", "PL", "CL", "EC", "FL1", "BL1",
    "SA", "DED", "PPL", "CLI", "PD", "WC"
  ];

  if (!allowedCodes.includes(code)) {
    return res.status(400).json({
      error: "Unsupported competition code.",
      availableCodes: allowedCodes
    });
  }

  const requestedSeasons = Number(req.query?.seasons || 3);
  const seasons = Number.isFinite(requestedSeasons)
    ? Math.min(3, Math.max(1, Math.floor(requestedSeasons)))
    : 3;

  const currentYear = new Date().getUTCFullYear();
  const seasonYears = Array.from(
    { length: seasons },
    (_, i) => currentYear - i
  );

  try {
    const allMatches = [];
    const seasonErrors = [];

    // Fetch seasons sequentially to limit API request bursts.
    for (const year of seasonYears) {
      const url =
        `https://api.football-data.org/v4/competitions/${code}/matches` +
        `?season=${year}`;

      const response = await fetch(url, {
        headers: { "X-Auth-Token": apiKey }
      });

      const data = await response.json();

      if (!response.ok) {
        seasonErrors.push({
          season: year,
          status: response.status,
          message: data.message || "Season unavailable"
        });
        continue;
      }

      for (const match of data.matches || []) {
        if (
          match.status === "FINISHED" &&
          Number.isFinite(match.score?.fullTime?.home) &&
          Number.isFinite(match.score?.fullTime?.away)
        ) {
          allMatches.push(match);
        }
      }
    }

    // Remove duplicates by match ID.
    const uniqueMatches = [
      ...new Map(allMatches.map(m => [m.id, m])).values()
    ].sort(
      (a, b) => new Date(a.utcDate) - new Date(b.utcDate)
    );

    if (uniqueMatches.length === 0) {
      return res.status(200).json({
        competition: code,
        seasonsRequested: seasonYears,
        matchesAnalysed: 0,
        message: "No completed matches were available for these seasons.",
        seasonErrors
      });
    }

    const now = Date.now();
    const halfLifeDays = 180;

    const teams = {};

    let weightedGoals = 0;
    let totalWeight = 0;
    let homeGoals = 0;
    let awayGoals = 0;

    function ensureTeam(id, name) {
      if (!teams[id]) {
        teams[id] = {
          id,
          name,
          matches: 0,
          goalsFor: 0,
          goalsAgainst: 0,
          weightedFor: 0,
          weightedAgainst: 0,
          totalWeight: 0,
          home: {
            matches: 0,
            weightedFor: 0,
            weightedAgainst: 0,
            weight: 0
          },
          away: {
            matches: 0,
            weightedFor: 0,
            weightedAgainst: 0,
            weight: 0
          },
          recent: []
        };
      }

      return teams[id];
    }

    for (const match of uniqueMatches) {
      const homeGoalsScored = match.score.fullTime.home;
      const awayGoalsScored = match.score.fullTime.away;

      const home = ensureTeam(
        match.homeTeam.id,
        match.homeTeam.name
      );

      const away = ensureTeam(
        match.awayTeam.id,
        match.awayTeam.name
      );

      const ageDays = Math.max(
        0,
        (now - new Date(match.utcDate).getTime()) /
          (1000 * 60 * 60 * 24)
      );

      // Recent matches contribute more; older matches
      // gradually lose influence.
      const weight = Math.pow(0.5, ageDays / halfLifeDays);

      home.matches++;
      home.goalsFor += homeGoalsScored;
      home.goalsAgainst += awayGoalsScored;
      home.weightedFor += homeGoalsScored * weight;
      home.weightedAgainst += awayGoalsScored * weight;
      home.totalWeight += weight;

      home.home.matches++;
      home.home.weightedFor += homeGoalsScored * weight;
      home.home.weightedAgainst += awayGoalsScored * weight;
      home.home.weight += weight;

      away.matches++;
      away.goalsFor += awayGoalsScored;
      away.goalsAgainst += homeGoalsScored;
      away.weightedFor += awayGoalsScored * weight;
      away.weightedAgainst += homeGoalsScored * weight;
      away.totalWeight += weight;

      away.away.matches++;
      away.away.weightedFor += awayGoalsScored * weight;
      away.away.weightedAgainst += homeGoalsScored * weight;
      away.away.weight += weight;

      home.recent.push({
        date: match.utcDate,
        opponent: away.name,
        venue: "HOME",
        goalsFor: homeGoalsScored,
        goalsAgainst: awayGoalsScored,
        result: homeGoalsScored > awayGoalsScored
          ? "W"
          : homeGoalsScored === awayGoalsScored ? "D" : "L"
      });

      away.recent.push({
        date: match.utcDate,
        opponent: home.name,
        venue: "AWAY",
        goalsFor: awayGoalsScored,
        goalsAgainst: homeGoalsScored,
        result: awayGoalsScored > homeGoalsScored
          ? "W"
          : awayGoalsScored === homeGoalsScored ? "D" : "L"
      });

      weightedGoals +=
        (homeGoalsScored + awayGoalsScored) * weight;
      totalWeight += 2 * weight;

      homeGoals += homeGoalsScored;
      awayGoals += awayGoalsScored;
    }

    const teamStats = Object.values(teams).map(team => ({
      id: team.id,
      name: team.name,
      matches: team.matches,
      goalsScored: team.goalsFor,
      goalsConceded: team.goalsAgainst,
      rawGoalsPerMatch: Number(
        (team.goalsFor / team.matches).toFixed(3)
      ),
      rawConcededPerMatch: Number(
        (team.goalsAgainst / team.matches).toFixed(3)
      ),
      weightedGoalsPerMatch: Number(
        (team.weightedFor / team.totalWeight).toFixed(3)
      ),
      weightedConcededPerMatch: Number(
        (team.weightedAgainst / team.totalWeight).toFixed(3)
      ),
      home: {
        matches: team.home.matches,
        weightedGoalsPerMatch: team.home.weight
          ? Number(
              (team.home.weightedFor / team.home.weight).toFixed(3)
            )
          : null,
        weightedConcededPerMatch: team.home.weight
          ? Number(
              (team.home.weightedAgainst / team.home.weight).toFixed(3)
            )
          : null
      },
      away: {
        matches: team.away.matches,
        weightedGoalsPerMatch: team.away.weight
          ? Number(
              (team.away.weightedFor / team.away.weight).toFixed(3)
            )
          : null,
        weightedConcededPerMatch: team.away.weight
          ? Number(
              (team.away.weightedAgainst / team.away.weight).toFixed(3)
            )
          : null
      },
      recentForm: team.recent
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5)
    }));

    return res.status(200).json({
      competition: code,
      seasonsRequested: seasonYears,
      matchesAnalysed: uniqueMatches.length,
      weighting: {
        method: "Exponential decay by match age",
        halfLifeDays,
        explanation:
          "A match 180 days old receives half the weight of a match today."
      },
      league: {
        averageGoalsPerMatch: Number(
          (homeGoals + awayGoals) / uniqueMatches.length
        .toFixed(3)),
        weightedAverageGoalsPerTeamPerMatch: Number(
          (weightedGoals / totalWeight).toFixed(3)
        )
      },
      teams: teamStats.sort((a, b) => a.name.localeCompare(b.name)),
      seasonErrors
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unable to retrieve historical statistics."
    });
  }
}
