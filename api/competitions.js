
export default async function handler(req, res) {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Football API key is not configured."
    });
  }

  try {
    const response = await fetch(
      "https://api.football-data.org/v4/competitions",
      {
        headers: {
          "X-Auth-Token": apiKey
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || "Could not retrieve competitions."
      });
    }

    return res.status(200).json({
      count: (data.competitions || []).length,
      competitions: (data.competitions || []).map(c => ({
        id: c.id,
        name: c.name,
        code: c.code,
        type: c.type,
        area: c.area?.name,
        currentSeason: c.currentSeason?.startDate,
        available: true
      }))
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unable to connect to the football data service."
    });
  }
}
