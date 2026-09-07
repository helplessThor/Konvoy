/**
 * KonvoyForegroundService.kt — Android Background Service
 *
 * Maintains persistent foreground execution for mesh radio,
 * microphone capture, and GPS location tracking.
 *
 * Required foreground service types:
 *   - FOREGROUND_SERVICE_MICROPHONE: Continuous voice capture
 *   - FOREGROUND_SERVICE_LOCATION: GPS telemetry broadcasting
 */

package com.konvoy.app.services

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

class KonvoyForegroundService : Service() {

    companion object {
        const val TAG = "KonvoyForeground"
        const val CHANNEL_ID = "konvoy_mesh_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.konvoy.app.START_SERVICE"
        const val ACTION_STOP = "com.konvoy.app.STOP_SERVICE"

        fun start(context: Context) {
            val intent = Intent(context, KonvoyForegroundService::class.java).apply {
                action = ACTION_START
            }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, KonvoyForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startMeshService()
            ACTION_STOP -> stopMeshService()
        }
        return START_STICKY
    }

    private fun startMeshService() {
        val notification = buildNotification(
            title = "Konvoy Active",
            body = "Group ride tracking & intercom ready"
        )

        // Start with both MICROPHONE and LOCATION foreground service types
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // Acquire partial wake lock to keep CPU alive for radio operations
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "konvoy:mesh_radio"
        ).apply {
            acquire(10 * 60 * 60 * 1000L) // 10 hours max
        }

        Log.i(TAG, "Konvoy foreground service started")
    }

    private fun stopMeshService() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        Log.i(TAG, "Konvoy foreground service stopped")
    }

    /**
     * Update the notification content (e.g., convoy peer count, signal strength).
     */
    fun updateNotification(title: String, body: String) {
        val notification = buildNotification(title, body)
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(title: String, body: String): Notification {
        // Intent to open the app when notification is tapped
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Stop action
        val stopIntent = Intent(this, KonvoyForegroundService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.ic_dialog_info) // TODO: Replace with Konvoy icon
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Konvoy Ride Service",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Maintains group intercom and live ride tracking"
            setShowBadge(false)
        }

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(channel)
    }

    override fun onDestroy() {
        super.onDestroy()
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
    }
}
