package app.ecrs.fetch;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Запросы телефона. Сертификат проверяется только по имени хоста:
 * на Android 6 хранилище центров старое и современные сертификаты не признаёт.
 */
final class Net {
    private static final int MAX_BYTES = 500_000;
    private static SSLSocketFactory factory;

    private Net() {}

    static final class Job {
        final int id;
        final String uid;

        Job(int id, String uid) {
            this.id = id;
            this.uid = uid;
        }
    }

    static Job poll(String base, String secret) throws Exception {
        HttpResult result = request("GET", base + "/api/ecrs/next", secret, null, hostOf(base));
        if (result.code == 204) return null;
        if (result.code != 200) throw new Exception("бот ответил " + result.code);
        JSONObject json = new JSONObject(result.body);
        String uid = json.getString("uid");
        if (!uid.matches("[0-9A-Fa-f]{24}")) throw new Exception("плохой номер чека");
        return new Job(json.getInt("id"), uid);
    }

    static String fetchReceipt(String uid) throws Exception {
        if (!uid.matches("[0-9A-Fa-f]{24}")) throw new Exception("плохой номер чека");
        HttpResult result = request("GET", "https://mch.ecrs.by/" + uid, null, null, "mch.ecrs.by");
        if (result.code != 200) throw new Exception("сайт чека ответил " + result.code);
        return result.body;
    }

    static void postResult(String base, String secret, int id, String html, String error) throws Exception {
        JSONObject json = new JSONObject();
        json.put("id", id);
        json.put("ok", error == null);
        if (error == null) json.put("html", html);
        else json.put("error", error);
        HttpResult result = request("POST", base + "/api/ecrs/result", secret, json.toString(), hostOf(base));
        if (result.code != 204 && result.code != 404) throw new Exception("бот не принял страницу: " + result.code);
    }

    private static String hostOf(String base) throws Exception {
        String host = new URL(base).getHost();
        if (!"finance-tracker-dev.aksnickolas.workers.dev".equals(host)
                && !"finance-tracker.aksnickolas.workers.dev".equals(host)
                && !"finance-tracker-dev.zoraleta.workers.dev".equals(host)
                && !"finance-tracker.zoraleta.workers.dev".equals(host)) {
            throw new Exception("неизвестный адрес бота");
        }
        return host;
    }

    private static HttpResult request(String method, String url, String secret, String json, String expectHost) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(20000);
        conn.setInstanceFollowRedirects(false);
        conn.setRequestMethod(method);
        conn.setRequestProperty("Accept", "application/json,text/html");
        conn.setRequestProperty("User-Agent", "ecrs-fetch");
        if (secret != null) conn.setRequestProperty("Authorization", "Bearer " + secret);
        if (conn instanceof HttpsURLConnection) {
            HttpsURLConnection https = (HttpsURLConnection) conn;
            https.setSSLSocketFactory(socketFactory());
            https.setHostnameVerifier(new FixedHost(expectHost));
        }
        if (json != null) {
            byte[] bytes = json.getBytes("UTF-8");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.getOutputStream().write(bytes);
        }
        int code = conn.getResponseCode();
        InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        String body = stream == null ? "" : readLimited(stream);
        conn.disconnect();
        return new HttpResult(code, body);
    }

    private static String readLimited(InputStream stream) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        int total = 0;
        while ((n = stream.read(buf)) >= 0) {
            total += n;
            if (total > MAX_BYTES) throw new Exception("страница слишком большая");
            out.write(buf, 0, n);
        }
        stream.close();
        return out.toString("UTF-8");
    }

    private static SSLSocketFactory socketFactory() throws Exception {
        if (factory != null) return factory;
        TrustManager[] trustAll = new TrustManager[]{new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}

            public void checkServerTrusted(X509Certificate[] chain, String authType) {}

            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        }};
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trustAll, new SecureRandom());
        factory = context.getSocketFactory();
        return factory;
    }

    private static final class FixedHost implements HostnameVerifier {
        private final String host;

        FixedHost(String host) {
            this.host = host;
        }

        public boolean verify(String hostname, SSLSession session) {
            return host.equals(hostname);
        }
    }

    private static final class HttpResult {
        final int code;
        final String body;

        HttpResult(int code, String body) {
            this.code = code;
            this.body = body;
        }
    }
}
