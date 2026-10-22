package app.ecrs.fetch;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;

/** Читает адрес бота и секрет с карты памяти, затем запускает службу. */
public class MainActivity extends Activity {
    static final String PREFS = "ecrs";
    static final String KEY_BASE = "base";
    static final String KEY_SECRET = "secret";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        readConfigFile();

        String base = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_BASE, null);
        TextView tv = new TextView(this);
        tv.setPadding(48, 48, 48, 48);
        tv.setTextSize(18);
        if (base == null) {
            tv.setText("Нет настройки.");
        } else {
            startService(new Intent(this, FetchService.class));
            tv.setText("Скачивание чеков включено. Экран можно выключить.");
        }
        setContentView(tv);
    }

    /** Две строки: адрес бота и секрет. Файл удаляется сразу после чтения. */
    private void readConfigFile() {
        File file = new File("/data/local/tmp/ecrs-fetch.txt");
        if (!file.isFile()) return;
        try {
            BufferedReader reader = new BufferedReader(new FileReader(file));
            String base = reader.readLine();
            String secret = reader.readLine();
            reader.close();
            if (base != null && secret != null && base.startsWith("https://") && secret.length() >= 16) {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString(KEY_BASE, base.trim())
                        .putString(KEY_SECRET, secret.trim())
                        .commit();
            }
        } catch (Exception ignored) {
            // файл битый — останутся прежние настройки
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
