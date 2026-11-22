package ru.matricarmz.tablet;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(ApkUpdaterPlugin.class);
    super.onCreate(savedInstanceState);
    WebView webView = getBridge().getWebView();
    WebSettings settings = webView.getSettings();
    settings.setSupportZoom(true);
    settings.setBuiltInZoomControls(true);
    settings.setDisplayZoomControls(false);
    // Уменьшение щипком (промт КАРМАНА #70, п.3): интерфейс должен не только
    // увеличиваться, но и уменьшаться НИЖЕ канона — чтобы мелкий текст и широкая
    // таблица поместились в экран планшета. Без широкого вьюпорта и режима обзора
    // WebView упирается в «страница и так вписана в экран»: щипком вниз уменьшить
    // нельзя. Нижняя граница масштаба — minimum-scale во viewport
    // (android-app/src/index.html), канон (100 %) — initial-scale.
    settings.setUseWideViewPort(true);
    settings.setLoadWithOverviewMode(true);
  }
}
