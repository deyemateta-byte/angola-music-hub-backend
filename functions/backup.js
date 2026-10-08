const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.database();
const bucket = admin.storage().bucket();

// ============================================
// BACKUP FUNCTIONS
// ============================================

// Create manual backup
exports.createBackup = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { adminId } = req.body;

      if (!adminId) {
        return res.status(400).json({ error: 'Admin ID required' });
      }

      // Verify admin
      const adminSnap = await db.ref(`admins/${adminId}`).once('value');
      if (!adminSnap.exists()) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      // Fetch all data
      const backup = {};

      const usersSnap = await db.ref('users').once('value');
      backup.users = usersSnap.val() || {};

      const tracksSnap = await db.ref('tracks').once('value');
      backup.tracks = tracksSnap.val() || {};

      const auditSnap = await db.ref('audit-logs').once('value');
      backup.auditLogs = auditSnap.val() || {};

      const analyticsSnap = await db.ref('analytics').once('value');
      backup.analytics = analyticsSnap.val() || {};

      const timestamp = new Date().toISOString();
      const filename = `backups/backup-${timestamp}.json`;

      // Upload to storage
      const file = bucket.file(filename);
      const backupData = JSON.stringify(backup, null, 2);
      
      await file.save(backupData, {
        metadata: {
          contentType: 'application/json',
          cacheControl: 'no-cache',
          custom: {
            timestamp,
            adminId,
            type: 'manual'
          }
        }
      });

      // Log backup
      await db.ref('backups-log').push({
        timestamp,
        filename,
        size: backupData.length,
        adminId,
        userCount: Object.keys(backup.users).length,
        songCount: Object.keys(backup.tracks).length,
        type: 'manual',
        status: 'success'
      });

      console.log(`Backup created: ${filename}`);

      res.json({
        success: true,
        filename,
        timestamp,
        userCount: Object.keys(backup.users).length,
        songCount: Object.keys(backup.tracks).length,
        size: backupData.length
      });
    } catch (error) {
      console.error('Backup error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// List backups
exports.listBackups = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { adminId } = req.body;

      // Verify admin
      const adminSnap = await db.ref(`admins/${adminId}`).once('value');
      if (!adminSnap.exists()) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const backupsLogSnap = await db.ref('backups-log').once('value');
      const backups = backupsLogSnap.val() || {};

      const backupList = Object.entries(backups)
        .map(([id, backup]) => ({ id, ...backup }))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      res.json({
        success: true,
        backups: backupList,
        total: backupList.length
      });
    } catch (error) {
      console.error('List backups error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Get backup details
exports.getBackupDetails = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { adminId, filename } = req.body;

      // Verify admin
      const adminSnap = await db.ref(`admins/${adminId}`).once('value');
      if (!adminSnap.exists()) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      if (!filename) {
        return res.status(400).json({ error: 'Filename required' });
      }

      const file = bucket.file(filename);
      const [metadata] = await file.getMetadata();

      res.json({
        success: true,
        filename,
        created: metadata.timeCreated,
        size: metadata.size,
        contentType: metadata.contentType
      });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// ============================================
// RESTORE FUNCTIONS
// ============================================

// Restore from backup
exports.restoreBackup = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { filename, adminId } = req.body;

      if (!filename || !adminId) {
        return res.status(400).json({ error: 'Filename and adminId required' });
      }

      // Verify admin
      const adminSnap = await db.ref(`admins/${adminId}`).once('value');
      if (!adminSnap.exists()) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      // Create restore log entry BEFORE restore
      const restoreLogId = await db.ref('restore-attempts').push({
        timestamp: admin.database.ServerValue.TIMESTAMP,
        from: filename,
        adminId,
        status: 'started'
      }).key;

      try {
        // Download backup
        const file = bucket.file(filename);
        const [data] = await file.download();
        const backup = JSON.parse(data.toString());

        // Clear current data
        await db.ref('users').remove();
        await db.ref('tracks').remove();
        await db.ref('analytics').remove();

        // Restore data
        const updates = {};
        updates['users'] = backup.users || {};
        updates['tracks'] = backup.tracks || {};
        updates['analytics'] = backup.analytics || {};

        await db.ref().update(updates);

        // Log successful restoration
        await db.ref(`restore-attempts/${restoreLogId}`).update({
          status: 'success',
          completedAt: admin.database.ServerValue.TIMESTAMP,
          restoredUsers: Object.keys(backup.users || {}).length,
          restoredSongs: Object.keys(backup.tracks || {}).length
        });

        console.log(`Backup restored: ${filename}`);

        res.json({
          success: true,
          message: 'Backup restored successfully',
          restoredUsers: Object.keys(backup.users || {}).length,
          restoredSongs: Object.keys(backup.tracks || {}).length
        });
      } catch (restoreError) {
        // Log failed restoration
        await db.ref(`restore-attempts/${restoreLogId}`).update({
          status: 'failed',
          error: restoreError.message,
          failedAt: admin.database.ServerValue.TIMESTAMP
        });

        throw restoreError;
      }
    } catch (error) {
      console.error('Restore error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Verify backup integrity
exports.verifyBackup = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { adminId, filename } = req.body;

      // Verify admin
      const adminSnap = await db.ref(`admins/${adminId}`).once('value');
      if (!adminSnap.exists()) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      if (!filename) {
        return res.status(400).json({ error: 'Filename required' });
      }

      const file = bucket.file(filename);
      const [data] = await file.download();
      const backup = JSON.parse(data.toString());

      // Validate structure
      const validation = {
        hasUsers: !!backup.users,
        hasTracks: !!backup.tracks,
        hasAuditLogs: !!backup.auditLogs,
        hasAnalytics: !!backup.analytics,
        userCount: Object.keys(backup.users || {}).length,
        trackCount: Object.keys(backup.tracks || {}).length,
        auditLogCount: Object.keys(backup.auditLogs || {}).length
      };

      // Check for critical data
      validation.isValid = validation.hasUsers && validation.hasTracks && validation.userCount > 0;

      res.json({
        success: true,
        filename,
        validation
      });
    } catch (error) {
      console.error('Verification error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// ============================================
// SCHEDULED BACKUPS
// ============================================

// Automatic daily backup at 2 AM
exports.scheduledDailyBackup = functions.pubsub
  .schedule('every day 02:00')
  .timeZone('America/New_York')
  .onRun(async (context) => {
    try {
      const backup = {};

      const usersSnap = await db.ref('users').once('value');
      backup.users = usersSnap.val() || {};

      const tracksSnap = await db.ref('tracks').once('value');
      backup.tracks = tracksSnap.val() || {};

      const auditSnap = await db.ref('audit-logs').once('value');
      backup.auditLogs = auditSnap.val() || {};

      const analyticsSnap = await db.ref('analytics').once('value');
      backup.analytics = analyticsSnap.val() || {};

      const timestamp = new Date().toISOString();
      const filename = `backups/backup-${timestamp}.json`;

      const file = bucket.file(filename);
      const backupData = JSON.stringify(backup, null, 2);

      await file.save(backupData, {
        metadata: {
          contentType: 'application/json',
          custom: {
            timestamp,
            adminId: 'system',
            type: 'automatic'
          }
        }
      });

      await db.ref('backups-log').push({
        timestamp,
        filename,
        size: backupData.length,
        adminId: 'system',
        userCount: Object.keys(backup.users).length,
        songCount: Object.keys(backup.tracks).length,
        type: 'automatic',
        status: 'success'
      });

      console.log(`Automatic backup created: ${filename}`);

      return null;
    } catch (error) {
      console.error('Scheduled backup error:', error);
      // Send alert
      await db.ref('alerts').push({
        type: 'backup_failed',
        message: error.message,
        timestamp: admin.database.ServerValue.TIMESTAMP,
        severity: 'high'
      });
    }
  });

// Weekly backup retention cleanup (keep last 30 days)
exports.cleanupOldBackups = functions.pubsub
  .schedule('every sunday 03:00')
  .timeZone('America/New_York')
  .onRun(async (context) => {
    try {
      const backupsLogSnap = await db.ref('backups-log').once('value');
      const backups = backupsLogSnap.val() || {};

      const backupList = Object.entries(backups)
        .map(([id, backup]) => ({ id, ...backup }))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      let deletedCount = 0;

      for (const backup of backupList) {
        const backupDate = new Date(backup.timestamp);
        if (backupDate < thirtyDaysAgo) {
          try {
            await bucket.file(backup.filename).delete();
            await db.ref(`backups-log/${backup.id}`).remove();
            deletedCount++;
          } catch (deleteError) {
            console.warn(`Failed to delete backup: ${backup.filename}`, deleteError);
          }
        }
      }

      console.log(`Cleanup completed. Deleted ${deletedCount} old backups.`);

      await db.ref('audit-logs').push({
        action: 'backup_cleanup',
        adminId: 'system',
        details: `Deleted ${deletedCount} backups older than 30 days`,
        timestamp: admin.database.ServerValue.TIMESTAMP
      });

      return null;
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  });

// ============================================
// DISASTER RECOVERY
// ============================================

// Emergency: Get latest backup filename
exports.getLatestBackup = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { adminId } = req.body;

      // Verify admin
      const adminSnap = await db.ref(`admins/${adminId}`).once('value');
      if (!adminSnap.exists()) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const backupsLogSnap = await db.ref('backups-log').once('value');
      const backups = backupsLogSnap.val() || {};

      const latestBackup = Object.values(backups)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

      if (!latestBackup) {
        return res.status(404).json({ error: 'No backups found' });
      }

      res.json({
        success: true,
        filename: latestBackup.filename,
        timestamp: latestBackup.timestamp,
        userCount: latestBackup.userCount,
        songCount: latestBackup.songCount
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

// Get restore history
exports.getRestoreHistory = functions.https.onRequest(async (req, res) => {
  const cors = require('cors')({ origin: true });
  cors(req, res, async () => {
    try {
      const { adminId } = req.body;

      // Verify admin
      const adminSnap = await db.ref(`admins/${adminId}`).once('value');
      if (!adminSnap.exists()) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const restoreSnap = await db.ref('restore-attempts').once('value');
      const attempts = restoreSnap.val() || {};

      const history = Object.entries(attempts)
        .map(([id, attempt]) => ({ id, ...attempt }))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 50); // Last 50 attempts

      res.json({
        success: true,
        history
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

module.exports = {
  createBackup: exports.createBackup,
  listBackups: exports.listBackups,
  getBackupDetails: exports.getBackupDetails,
  restoreBackup: exports.restoreBackup,
  verifyBackup: exports.verifyBackup,
  scheduledDailyBackup: exports.scheduledDailyBackup,
  cleanupOldBackups: exports.cleanupOldBackups,
  getLatestBackup: exports.getLatestBackup,
  getRestoreHistory: exports.getRestoreHistory
};
