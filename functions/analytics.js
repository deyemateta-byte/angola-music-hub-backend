const functions = require('firebase-functions');
const admin = require('firebase-admin');

const db = admin.database();

// Track events
exports.trackEvent = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { userId, event, data } = req.body;

      if (!userId || !event) {
        return res.status(400).json({ error: 'Missing userId or event' });
      }

      const eventData = {
        userId,
        event,
        data: data || {},
        timestamp: admin.database.ServerValue.TIMESTAMP,
        date: new Date().toISOString().split('T')[0]
      };

      // Store event
      await db.ref('events').push(eventData);

      // Update user stats
      const userRef = db.ref(`user-stats/${userId}/${eventData.date}`);
      const snap = await userRef.once('value');
      const current = snap.val() || { count: 0 };

      await userRef.update({
        count: current.count + 1,
        lastUpdate: admin.database.ServerValue.TIMESTAMP
      });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

// Get analytics report
exports.getAnalyticsReport = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { days = 7 } = req.query;

      const usersSnap = await db.ref('users').once('value');
      const tracksSnap = await db.ref('tracks').once('value');

      const users = usersSnap.val() || {};
      const tracks = tracksSnap.val() || {};

      const totalUsers = Object.keys(users).length;
      const totalSongs = Object.keys(tracks).length;
      const totalPlays = Object.values(tracks).reduce((sum, track) => sum + (track.plays || 0), 0);

      const genreStats = {};
      Object.values(tracks).forEach((track) => {
        genreStats[track.genre] = (genreStats[track.genre] || 0) + 1;
      });

      const artistStats = {};
      Object.values(tracks).forEach((track) => {
        if (!artistStats[track.artist]) {
          artistStats[track.artist] = { plays: 0, songs: 0 };
        }
        artistStats[track.artist].plays += track.plays || 0;
        artistStats[track.artist].songs += 1;
      });

      const topArtists = Object.entries(artistStats)
        .map(([name, stats]) => ({ name, ...stats }))
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 10);

      res.json({
        summary: {
          totalUsers,
          totalSongs,
          totalPlays,
          avgPlaysPerSong: Math.round(totalPlays / totalSongs || 0)
        },
        genreDistribution: genreStats,
        topArtists,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

// Get trending songs
exports.getTrendingSongs = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { hours = 24 } = req.query;

      const tracksSnap = await db.ref('tracks').once('value');
      const tracks = tracksSnap.val() || {};

      const trending = Object.values(tracks)
        .sort((a, b) => (b.plays || 0) - (a.plays || 0))
        .slice(0, 20)
        .map((track) => ({
          title: track.title,
          artist: track.artist,
          plays: track.plays || 0,
          genre: track.genre
        }));

      res.json({ trending });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

// Daily report
exports.sendDailyReport = functions.pubsub
  .schedule('every day 09:00')
  .timeZone('America/New_York')
  .onRun(async (context) => {
    try {
      const today = new Date().toISOString().split('T')[0];

      const usersSnap = await db.ref('users').once('value');
      const tracksSnap = await db.ref('tracks').once('value');

      const users = usersSnap.val() || {};
      const tracks = tracksSnap.val() || {};

      const report = {
        date: today,
        totalUsers: Object.keys(users).length,
        totalSongs: Object.keys(tracks).length,
        totalPlays: Object.values(tracks).reduce((sum, t) => sum + (t.plays || 0), 0),
        newUsers: 0,
        activeUsers: 0
      };

      await db.ref(`reports/daily/${today}`).set(report);

      console.log(`Daily report created: ${today}`);
      return null;
    } catch (error) {
      console.error('Report error:', error);
    }
  });

module.exports = {
  trackEvent: exports.trackEvent,
  getAnalyticsReport: exports.getAnalyticsReport,
  getTrendingSongs: exports.getTrendingSongs,
  sendDailyReport: exports.sendDailyReport
};
