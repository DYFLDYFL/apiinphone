package com.apiinphone.client;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ChatGptWebView")
public class ChatGptWebViewPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), ChatGptWebViewActivity.class);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("无法打开 ChatGPT 网页：" + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        ChatGptWebViewActivity.closeCurrent();
        call.resolve();
    }
}
