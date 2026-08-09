package com.apiinphone.client;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.os.Message;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Locale;

public class ChatGptWebViewActivity extends Activity {
    private static final String CHATGPT_URL = "https://chatgpt.com/";
    private WebView webView;
    private FrameLayout webContainer;
    private WebView popupWebView;
    private Button popupBackButton;
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

        Button browser = new Button(this);
        browser.setText("浏览器");
        browser.setOnClickListener(v -> openInBrowser(currentUrl()));
        toolbar.addView(browser, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

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
        if (popupWebView != null) {
            if (popupWebView.canGoBack()) {
                popupWebView.goBack();
            } else {
                closePopupWindow();
            }
            return;
        }
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        if (webContainer != null) {
            closePopupWindow();
            if (webView != null) {
                webContainer.removeView(webView);
                destroyWebView(webView);
            }
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

    private void destroyWebView(WebView view) {
        view.stopLoading();
        view.loadUrl("about:blank");
        view.destroy();
    }

    private void closePopupWindow() {
        WebView popup = popupWebView;
        popupWebView = null;
        if (popupBackButton != null && webContainer != null) {
            webContainer.removeView(popupBackButton);
            popupBackButton = null;
        }
        if (popup != null) {
            if (webContainer != null) webContainer.removeView(popup);
            destroyWebView(popup);
        }
    }

    private void showPopupWindow(WebView popup) {
        popup.setBackgroundColor(Color.WHITE);
        webContainer.addView(popup, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        popupWebView = popup;
        popup.bringToFront();
        popup.requestFocus();

        popupBackButton = new Button(this);
        popupBackButton.setText("返回");
        popupBackButton.setOnClickListener(v -> closePopupWindow());
        FrameLayout.LayoutParams buttonParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.TOP | Gravity.END
        );
        buttonParams.topMargin = 8;
        buttonParams.rightMargin = 8;
        webContainer.addView(popupBackButton, buttonParams);
        popupBackButton.bringToFront();
    }

    private static boolean isAllowedHost(String host) {
        if (host == null) return false;
        String normalized = host.toLowerCase(Locale.ROOT);
        return normalized.equals("chatgpt.com")
            || normalized.endsWith(".chatgpt.com")
            || normalized.equals("openai.com")
            || normalized.endsWith(".openai.com")
            || normalized.equals("auth.openai.com")
            || normalized.endsWith(".auth.openai.com")
            || normalized.equals("auth0.openai.com")
            || normalized.endsWith(".auth0.openai.com")
            || normalized.equals("appleid.apple.com");
    }

    private static boolean isGoogleAuthHost(String host) {
        if (host == null) return false;
        String normalized = host.toLowerCase(Locale.ROOT);
        return normalized.equals("accounts.google.com")
            || normalized.endsWith(".accounts.google.com")
            || normalized.equals("accounts.googleusercontent.com")
            || normalized.endsWith(".accounts.googleusercontent.com")
            || normalized.equals("google.com")
            || normalized.endsWith(".google.com")
            || normalized.equals("googleusercontent.com")
            || normalized.endsWith(".googleusercontent.com")
            || normalized.equals("gstatic.com")
            || normalized.endsWith(".gstatic.com");
    }

    private String currentUrl() {
        if (webView != null) {
            String url = webView.getUrl();
            if (url != null && url.startsWith("https://")) return url;
        }
        return CHATGPT_URL;
    }

    private static void openInBrowser(Context context, Uri uri) {
        try {
            context.startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception error) {
            Toast.makeText(context, "无法打开系统浏览器：" + error.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private void openInBrowser(String url) {
        openInBrowser(this, Uri.parse(url));
    }

    private class ChatGptChromeClient extends WebChromeClient {
        @Override
        public boolean onCreateWindow(
            WebView view,
            boolean isDialog,
            boolean isUserGesture,
            Message resultMsg
        ) {
            if (webContainer == null) return false;
            closePopupWindow();
            WebView popup = createWebView();
            showPopupWindow(popup);
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public void onCloseWindow(WebView window) {
            if (window == popupWebView) closePopupWindow();
        }
    }

    private class SafeWebViewClient extends WebViewClient {
        @Override
        public void onPageFinished(WebView view, String url) {
            CookieManager.getInstance().flush();
            super.onPageFinished(view, url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(Uri.parse(url));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl());
        }

        @Override
        public void onReceivedError(
            WebView view,
            WebResourceRequest request,
            WebResourceError error
        ) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                Toast.makeText(
                    ChatGptWebViewActivity.this,
                    "登录页面加载失败，请检查网络后重试",
                    Toast.LENGTH_SHORT
                ).show();
            }
        }

        @Override
        public boolean onRenderProcessGone(
            WebView view,
            RenderProcessGoneDetail detail
        ) {
            if (view == popupWebView) {
                closePopupWindow();
            } else if (view == webView && webContainer != null) {
                String reloadUrl = view.getUrl();
                webContainer.removeView(view);
                view.destroy();
                webView = createWebView();
                webContainer.addView(webView, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                ));
                webView.loadUrl(
                    reloadUrl != null && reloadUrl.startsWith("https://")
                        ? reloadUrl
                        : CHATGPT_URL
                );
            }
            Toast.makeText(
                ChatGptWebViewActivity.this,
                "网页进程已恢复，请重试登录",
                Toast.LENGTH_SHORT
            ).show();
            return true;
        }

        private boolean handleUrl(Uri uri) {
            if (uri == null) return true;
            String scheme = uri.getScheme();
            if (!"https".equalsIgnoreCase(scheme)) {
                openInBrowser(ChatGptWebViewActivity.this, uri);
                return true;
            }
            if (isGoogleAuthHost(uri.getHost())) {
                closePopupWindow();
                openInBrowser(ChatGptWebViewActivity.this, uri);
                return true;
            }
            if (isAllowedHost(uri.getHost())) {
                return false;
            }
            openInBrowser(ChatGptWebViewActivity.this, uri);
            return true;
        }
    }
}
