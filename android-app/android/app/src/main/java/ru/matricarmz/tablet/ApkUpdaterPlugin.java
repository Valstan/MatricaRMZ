package ru.matricarmz.tablet;

// Самообновление планшетного клиента: скачивает APK с сервера (с проверкой
// sha256), показывает нативный диалог прогресса и передаёт файл системному
// установщику пакетов через FileProvider. Дальше Android сам спрашивает
// пользователя «Обновить приложение?» и ставит новую версию поверх — данные
// (реплика SQLCipher) не трогаются, подпись у релизов одна и та же (ключ CI).
//
// Первая установка обновления потребует разового разрешения «Установка из
// неизвестных источников» для этого приложения — системный экран откроется сам.

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

  @PluginMethod
  public void downloadAndInstall(PluginCall call) {
    final String url = call.getString("url", "");
    final String sha256 = call.getString("sha256", "");
    final String fileName = call.getString("fileName", "update.apk");
    final long expectedSize = call.getLong("size", 0L);
    if (url == null || url.isEmpty()) {
      call.reject("url обязателен");
      return;
    }

    final Handler ui = new Handler(Looper.getMainLooper());
    final Context ctx = getContext();

    // Нативный диалог прогресса — виден поверх WebView, обновление нельзя
    // перепутать с зависанием (тот же урок, что у Windows-заглушки).
    final ProgressBar bar = new ProgressBar(getActivity(), null, android.R.attr.progressBarStyleHorizontal);
    bar.setMax(100);
    final TextView label = new TextView(getActivity());
    label.setText("Скачиваю обновление…");
    final LinearLayout box = new LinearLayout(getActivity());
    box.setOrientation(LinearLayout.VERTICAL);
    int pad = (int) (16 * ctx.getResources().getDisplayMetrics().density);
    box.setPadding(pad, pad, pad, pad);
    box.addView(label);
    box.addView(bar);
    final AlertDialog[] dialog = new AlertDialog[1];
    ui.post(() -> {
      dialog[0] = new AlertDialog.Builder(getActivity())
          .setTitle("Обновление программы")
          .setView(box)
          .setCancelable(false)
          .create();
      dialog[0].show();
    });

    new Thread(() -> {
      File dest = new File(ctx.getCacheDir(), "updates");
      //noinspection ResultOfMethodCallIgnored
      dest.mkdirs();
      File apk = new File(dest, fileName);
      try {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(30_000);
        conn.setReadTimeout(120_000);
        long total = conn.getContentLengthLong() > 0 ? conn.getContentLengthLong() : expectedSize;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
          byte[] buf = new byte[64 * 1024];
          long done = 0;
          int n;
          while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            digest.update(buf, 0, n);
            done += n;
            if (total > 0) {
              final int pct = (int) (done * 100 / total);
              ui.post(() -> {
                bar.setProgress(pct);
                label.setText("Скачиваю обновление… " + pct + "%");
              });
            }
          }
        }
        if (sha256 != null && !sha256.isEmpty()) {
          StringBuilder hex = new StringBuilder();
          for (byte b : digest.digest()) hex.append(String.format("%02x", b));
          if (!hex.toString().equalsIgnoreCase(sha256)) {
            throw new IllegalStateException("контрольная сумма не совпала — файл скачан с ошибкой");
          }
        }
        ui.post(() -> {
          if (dialog[0] != null) dialog[0].dismiss();
          Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
          Intent intent = new Intent(Intent.ACTION_VIEW);
          intent.setDataAndType(uri, "application/vnd.android.package-archive");
          intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
          ctx.startActivity(intent);
          JSObject ret = new JSObject();
          ret.put("started", true);
          call.resolve(ret);
        });
      } catch (Exception e) {
        //noinspection ResultOfMethodCallIgnored
        apk.delete();
        ui.post(() -> {
          if (dialog[0] != null) dialog[0].dismiss();
          new AlertDialog.Builder(getActivity())
              .setTitle("Обновление не удалось")
              .setMessage(String.valueOf(e.getMessage()))
              .setPositiveButton("Понятно", null)
              .show();
          call.reject(String.valueOf(e.getMessage()));
        });
      }
    }, "apk-updater").start();
  }
}
