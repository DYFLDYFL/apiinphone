package com.apiinphone.client;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.os.Message;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Locale;

public class ChatGptWebViewActivity extends Activity {
    private static final String CHATGPT_URL = "https://chatgpt.com/";
    private WebView webView;
    private FrameLayout webContainer;
    private static ChatGptWebViewActivity current;

    public static void closeCurrent() {
        if (current != null) current.finish();
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = this;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(12, 8, 12, 8);

        Button back = new Button(this);
        back.setText("‹");
        back.setOnClickListener(v -> {
            if (webView != null && webView.canGoBack()) webView.goBack();
            else finish();
        });
        toolbar.addView(back, new LinearLayout.LayoutParams(52, 52));

        TextView title = new TextView(this);
        title.setText("ChatGPT 网页");
        title.setTextColor(Color.DKGRAY);
        title.setTextSize(17);
        title.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.addView(
            title,
            new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1)
        );

        Button close = new Button(this);
        close.setText("关闭");
        close.setOnClickListener(v -> finish());
        toolbar.addView(close, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        root.addView(toolbar);

        webContainer = new FrameLayout(this);
        webView = createWebView();
        webView.loadUrl(CHATGPT_URL);
        webContainer.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        root.addView(webContainer, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1
        ));

        setContentView(root);
    }

    @Override
    public void onBackPressed() {
        if (webContainer != null && webContainer.getChildCount() > 1) {
            WebView popup = (WebView) webContainer.getChildAt(webContainer.getChildCount() - 1);
            webContainer.removeView(popup);
            popup.destroy();
            return;
        }
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        if (webContainer != null) {
            webContainer.removeAllViews();
            webContainer = null;
        }
        webView = null;
        super.onDestroy();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setBuiltInZoomControls(false);
        settings.setSupportZoom(false);
        String userAgent = settings.getUserAgentString()
            .replace("; wv", "")
            .replace(" Version/4.0", "");
        settings.setUserAgentString(userAgent);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        view.setWebViewClient(new SafeWebViewClient());
        view.setWebChromeClient(new ChatGptChromeClient());
        return view;
    }

    private static boolean isAllowedHost(String host) {
        if (host == null) return false;
        String normalized = host.toLowerCase(Locale.ROOT);
        return normalized.equals("chatgpt.com")
            || normalized.endsWith(".chatgpt.com")
            || normalized.equals("openai.com")
            || normalized.endsWith(".openai.com")
            || normalized.equals("accounts.google.com")
            || normalized.endsWith(".accounts.google.com")
            || normalized.equals("accounts.googleusercontent.com")
            || normalized.endsWith(".googleusercontent.com")
            || normalized.equals("gstatic.com")
            || normalized.endsWith(".gstatic.com")
            || normalized.equals("appleid.apple.com");
    }

    private class ChatGptChromeClient extends WebChromeClient {
        @Override
        public boolean onCreateWindow(
            WebView view,
            boolean isDialog,
            boolean isUserGesture,
            Message resultMsg
        ) {
            WebView popup = createWebView();
            webContainer.addView(popup, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            ));
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public void onCloseWindow(WebView window) {
            if (webContainer != null && window != webView) {
                webContainer.removeView(window);
                window.destroy();
            }
        }
    }

    private class SafeWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(Uri.parse(url));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl());
        }

        private boolean handleUrl(Uri uri) {
            if ("https".equalsIgnoreCase(uri.getScheme()) && isAllowedHost(uri.getHost())) {
                return false;
            }
            if (uri != null) {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            }
            return true;
        }
    }
}
