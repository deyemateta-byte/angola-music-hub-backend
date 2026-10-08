const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });

admin.initializeApp();

const db = admin.database();
const storage = admin.storage();
const auth = admin.auth();

// ============================================
// VALIDATION FUNCTIONS
// ============================================

function validateSong(data) {
  const errors = [];

  if (!data.title || typeof data.title !== 'string') {
    errors.push('Invalid title');
  } else if (data.title.length < 3 || data.title.length > 200) {
    errors.push('Title must be 3-200 characters');
  }

  if (!data.artist || typeof data.artist !== 'string') {
    errors.push('Invalid artist');
  } else if (data.artist.length < 2 || data.artist.length > 200) {
    errors.push('Artist must be 2-200 characters');
  }

  if (!data.track || typeof data.track !== 'string') {
    errors.push('Invalid track URL');
  } else if (!isValidUrl(data.track)) {
    errors.push('Track must be a valid URL');
  } else if (!data.track.match(/\.(mp3|wav|m4a|flac)$/i)) {
    errors.push('Track must be audio file (mp3, wav, m4a, flac)');
  }

  const validGenres = ['kuduro', 'kizomba', 'semba', 'afrobeat', 'rap', 'rnb', 'gospel', 'international'];
  if (!data.genre || !validGenres.includes(data.genre)) {
    errors.push('Invalid genre');
  }

  if (data.description && data.description.length > 1000) {
    errors.push('Description must be under 1000 characters');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateUser(data) {
  const errors = [];

  if (!data.name || typeof data.name !== 'string') {
    errors.push('Invalid name');
  } else if (data.name.length < 2 || data.name.length > 100) {
    errors.push('Name must be 2-100 characters');
  }

  if (!data.email || !isValidEmail(data.email)) {
    errors.push('Invalid email');
  }

  if (data.bio && data.bio.length > 500) {
    errors.push('Bio must be under 500 characters');
  }

  if (data.location && data.location.length > 100) {
    errors.push('Location must be under 100 characters');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// ============================================
// ABUSE DETECTION
// ============================================

async function checkAbuse(uid, action, limit = 10) {
  const ref = db.ref(`rate-limits/${uid}/${action}`);
  const snap = await ref.once('value');
  const data = snap.val();

  if (!data) {
    await ref.set({
      count: 1,
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
    return false;
  }

  const timeDiff = Date.now() - data.timestamp;
  const oneHour = 60 * 60 * 1000;

  if (timeDiff < oneHour && data.count >= limit) {
    return true; // Abuse detected
  }

  if (timeDiff >= oneHour) {
    // Reset counter after 1 hour
    await ref.set({
      count: 1,
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
  } else {
    // Increment counter
    await ref.update({
      count: data.count + 1
    });
  }

  return false;
}

async function flagUser(uid, reason, severity = 'medium') {
  const ref = db.ref(`users/${uid}`);
  const snap = await ref.once('value');
  const user = snap.val();

  const violations = user.violations || [];
  violations.push({
    reason,
    severity,
    timestamp: admin.database.ServerValue.TIMESTAMP
  });

  await ref.update({
    violations,
    flagged: true
  });

  // Log to admin reports
  await db.ref('admin/reports').push({
    type: 'user_flag',
    userId: uid,
    reason,
    severity,
    timestamp: admin.database.ServerValue.TIMESTAMP
  });

  // Ban if too many violations
  if (violations.length >= 3) {
    await db.ref(`users/${uid}`).update({ banned: true });
    await logAudit('system', 'user_banned', uid, 'Too many violations');
  }
}

// ============================================
// AUDIT LOGGING
// ============================================

async function logAudit(adminId, action, targetId, details = '') {
  return db.ref('audit-logs').push({
    adminId,
    action,
    targetId,
    details,
    timestamp: admin.database.ServerValue.TIMESTAMP
  });
}

// ============================================
// CLOUD FUNCTIONS
// ============================================

// Validate & store song upload
exports.validateSongUpload = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { uid, title, artist, genre, track, description } = req.body;

      // Check authentication
      if (!uid || !req.headers.authorization) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Rate limit check
      const isAbuse = await checkAbuse(uid, 'upload', 10);
      if (isAbuse) {
        return res.status(429).json({ error: 'Too many uploads, try again later' });
      }

      // Validate data
      const validation = validateSong({ title, artist, genre, track, description });
      if (!validation.valid) {
        return res.status(400).json({ errors: validation.errors });
      }

      // Check if user is banned
      const userRef = await db.ref(`users/${uid}`).once('value');
      const user = userRef.val();
      if (user && user.banned) {
        return res.status(403).json({ error: 'Your account is banned' });
      }

      // Store song
      const songId = db.ref('tracks').push().key;
      const songData = {
        id: songId,
        title,
        artist,
        genre,
        track,
        description: description || '',
        artistId: uid,
        uploadedAt: admin.database.ServerValue.TIMESTAMP,
        plays: 0,
        flagged: false
      };

      const updates = {};
      updates[`tracks/${songId}`] = songData;
      updates[`users/${uid}/songs/${songId}`] = songData;

      await db.ref().update(updates);

      // Log
      await logAudit(uid, 'song_upload', songId, title);

      res.json({
        success: true,
        songId,
        message: 'Song uploaded successfully'
      });
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Increment play count with validation
exports.incrementPlayCount = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { trackId, userId } = req.body;

      if (!trackId) {
        return res.status(400).json({ error: 'Missing trackId' });
      }

      // Check for suspicious play patterns
      if (userId) {
        const isAbuse = await checkAbuse(userId, `play-${trackId}`, 5);
        if (isAbuse) {
          return res.status(429).json({ error: 'Play limit exceeded' });
        }
      }

      // Increment play count
      const trackRef = db.ref(`tracks/${trackId}`);
      await trackRef.update({
        plays: admin.database.ServerValue.increment(1)
      });

      // Update user stats
      if (userId) {
        await db.ref(`users/${userId}/totalPlays`).update(
          admin.database.ServerValue.increment(1)
        );
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Play count error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Secure follow action
exports.secureFollow = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { userId, artistId } = req.body;

      if (!userId || !artistId) {
        return res.status(400).json({ error: 'Missing user or artist ID' });
      }

      if (userId === artistId) {
        return res.status(400).json({ error: 'Cannot follow yourself' });
      }

      // Rate limit
      const isAbuse = await checkAbuse(userId, 'follow', 50);
      if (isAbuse) {
        return res.status(429).json({ error: 'Too many follows' });
      }

      // Check if both users exist
      const userSnap = await db.ref(`users/${userId}`).once('value');
      const artistSnap = await db.ref(`users/${artistId}`).once('value');

      if (!userSnap.exists() || !artistSnap.exists()) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updates = {};
      updates[`users/${userId}/following/${artistId}`] = true;
      updates[`users/${artistId}/followers/${userId}`] = true;

      await db.ref().update(updates);

      // Log
      await logAudit(userId, 'follow', artistId);

      res.json({ success: true });
    } catch (error) {
      console.error('Follow error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Validate user profile update
exports.updateUserProfile = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { uid, name, bio, location, avatar } = req.body;

      if (!uid) {
        return res.status(400).json({ error: 'Missing user ID' });
      }

      // Validate data
      const validation = validateUser({ name, bio, location, email: 'test@test.com' });
      if (!validation.valid) {
        return res.status(400).json({ errors: validation.errors });
      }

      // Rate limit profile updates
      const isAbuse = await checkAbuse(uid, 'profile_update', 5);
      if (isAbuse) {
        return res.status(429).json({ error: 'Too many updates' });
      }

      const updates = {};
      if (name) updates[`users/${uid}/name`] = name;
      if (bio) updates[`users/${uid}/bio`] = bio;
      if (location) updates[`users/${uid}/location`] = location;
      if (avatar) updates[`users/${uid}/avatar`] = avatar;

      await db.ref().update(updates);

      // Log
      await logAudit(uid, 'profile_update', uid, Object.keys(updates).join(','));

      res.json({ success: true });
    } catch (error) {
      console.error('Profile update error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Delete song (with admin check)
exports.deleteSong = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { trackId, uid, adminId } = req.body;

      if (!trackId || !uid) {
        return res.status(400).json({ error: 'Missing trackId or uid' });
      }

      // Get track
      const trackSnap = await db.ref(`tracks/${trackId}`).once('value');
      const track = trackSnap.val();

      if (!track) {
        return res.status(404).json({ error: 'Song not found' });
      }

      // Check ownership or admin
      if (track.artistId !== uid && !adminId) {
        return res.status(403).json({ error: 'Permission denied' });
      }

      // Delete
      const updates = {};
      updates[`tracks/${trackId}`] = null;
      updates[`users/${track.artistId}/songs/${trackId}`] = null;

      await db.ref().update(updates);

      // Log
      await logAudit(adminId || uid, 'song_delete', trackId, track.title);

      res.json({ success: true });
    } catch (error) {
      console.error('Delete error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Ban user (admin only)
exports.banUser = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { targetUid, adminId, reason } = req.body;

      if (!targetUid || !adminId || !reason) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Verify admin
      const adminSnap = await db.ref(`admins/${adminId}`).once('value');
      if (!adminSnap.exists()) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      // Ban user
      await db.ref(`users/${targetUid}`).update({
        banned: true,
        bannedAt: admin.database.ServerValue.TIMESTAMP,
        banReason: reason
      });

      // Log
      await logAudit(adminId, 'user_banned', targetUid, reason);

      res.json({ success: true });
    } catch (error) {
      console.error('Ban error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Get suspicious users (for dashboard)
exports.getSuspiciousUsers = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const { adminId } = req.body;

      // Verify admin
      const adminSnap = await db.ref(`admins/${adminId}`).once('value');
      if (!adminSnap.exists()) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const usersSnap = await db.ref('users').once('value');
      const users = usersSnap.val() || {};

      const suspicious = [];
      for (const [uid, user] of Object.entries(users)) {
        const violations = user.violations || [];
        if (violations.length > 0 || user.flagged || user.banned) {
          suspicious.push({
            uid,
            name: user.name,
            violations: violations.length,
            flagged: user.flagged,
            banned: user.banned,
            totalPlays: user.totalPlays || 0
          });
        }
      }

      res.json({
        success: true,
        suspicious: suspicious.sort((a, b) => b.violations - a.violations)
      });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Automatic backup
exports.scheduledBackup = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async (context) => {
    try {
      const timestamp = new Date().toISOString();
      const backup = {};

      // Backup users
      const usersSnap = await db.ref('users').once('value');
      backup.users = usersSnap.val();

      // Backup tracks
      const tracksSnap = await db.ref('tracks').once('value');
      backup.tracks = tracksSnap.val();

      // Backup audit logs
      const auditSnap = await db.ref('audit-logs').once('value');
      backup.auditLogs = auditSnap.val();

      // Store in storage
      const file = storage.bucket().file(`backups/backup-${timestamp}.json`);
      await file.save(JSON.stringify(backup, null, 2), {
        metadata: {
          contentType: 'application/json'
        }
      });

      console.log(`Backup created: backup-${timestamp}.json`);

      return null;
    } catch (error) {
      console.error('Backup error:', error);
    }
  });

// Analytics: Track daily stats
exports.trackDailyStats = functions.pubsub
  .schedule('every day 00:00')
  .timeZone('America/New_York')
  .onRun(async (context) => {
    try {
      const today = new Date().toISOString().split('T')[0];

      const usersSnap = await db.ref('users').once('value');
      const tracksSnap = await db.ref('tracks').once('value');

      const users = usersSnap.val() || {};
      const tracks = tracksSnap.val() || {};

      let totalPlays = 0;
      let totalUsers = Object.keys(users).length;
      let totalSongs = Object.keys(tracks).length;
      let totalFollows = 0;

      for (const user of Object.values(users)) {
        totalPlays += user.totalPlays || 0;
        totalFollows += Object.keys(user.followers || {}).length;
      }

      await db.ref(`analytics/daily/${today}`).set({
        totalUsers,
        totalSongs,
        totalPlays,
        totalFollows,
        timestamp: admin.database.ServerValue.TIMESTAMP
      });

      console.log(`Daily stats tracked: ${today}`);

      return null;
    } catch (error) {
      console.error('Analytics error:', error);
    }
  });

module.exports = {
  validateSongUpload: exports.validateSongUpload,
  incrementPlayCount: exports.incrementPlayCount,
  secureFollow: exports.secureFollow,
  updateUserProfile: exports.updateUserProfile,
  deleteSong: exports.deleteSong,
  banUser: exports.banUser,
  getSuspiciousUsers: exports.getSuspiciousUsers,
  scheduledBackup: exports.scheduledBackup,
  trackDailyStats: exports.trackDailyStats
};
