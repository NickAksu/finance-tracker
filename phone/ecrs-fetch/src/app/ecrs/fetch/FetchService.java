package app.ecrs.fetch;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.wifi.WifiManager;
import android.os.IBinder;
import android.os.PowerManager;

/** Раз в двадцать секунд спрашивает бота, есть ли номер чека. */
public class FetchService extends Service implements Runnable {
    private static final int NOTIFICATION_ID = 1;
    private volatile boolean running;
    private Thread thread;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private String status = "Жду чек";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        show(status);
        if (thread == null) {
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ecrs:fetch");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL, "ecrs:wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
            running = true;
            thread = new Thread(this, "ecrs-fetch");
            thread.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (thread != null) thread.interrupt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
    }

    @Override
    public void run() {
        while (running) {
            SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
            String base = prefs.getString(MainActivity.KEY_BASE, null);
            String secret = prefs.getString(MainActivity.KEY_SECRET, null);
            long pause = 20000;
            if (base == null || secret == null) {
                status = "Нет настройки";
                pause = 60000;
            } else {
                Net.Job job = null;
                try {
                    job = Net.poll(base, secret);
                    if (job == null) {
                        status = "Жду чек";
                    } else {
                        status = "Скачиваю чек";
                        show(status);
                        String html = Net.fetchReceipt(job.uid);
                        Net.postResult(base, secret, job.id, html, null);
                        status = "Чек отдан боту";
                    }
                } catch (Exception e) {
                    status = e.getMessage() == null ? "Ошибка" : e.getMessage();
                    if (job != null) {
                        try {
                            Net.postResult(base, secret, job.id, null, status);
                        } catch (Exception ignored) {
                            pause = 60000;
                        }
                    } else {
                        pause = 60000;
                    }
                }
            }
            show(status);
            try {
                Thread.sleep(pause);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    private void show(String text) {
        Notification notification = new Notification.Builder(this)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Чеки")
                .setContentText(text)
                .setOngoing(true)
                .build();
        startForeground(NOTIFICATION_ID, notification);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, notification);
    }
}
