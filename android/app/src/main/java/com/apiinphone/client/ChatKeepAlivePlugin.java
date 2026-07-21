package com.apiinphone.client;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "ChatKeepAlive",
    permissions = {
        @Permission(
            alias = "display",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class ChatKeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "AI API Client");
        String body = call.getString("body", "正在生成…");
        Intent intent = new Intent(getContext(), ChatKeepAliveService.class);
        intent.putExtra(ChatKeepAliveService.EXTRA_TITLE, title);
        intent.putExtra(ChatKeepAliveService.EXTRA_BODY, body);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("无法启动后台保活：" + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), ChatKeepAliveService.class);
            getContext().stopService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("无法停止后台保活：" + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject result = new JSObject();
        result.put("display", notificationPermissionState());
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            JSObject result = new JSObject();
            result.put("display", "granted");
            call.resolve(result);
            return;
        }
        if ("granted".equals(notificationPermissionState())) {
            JSObject result = new JSObject();
            result.put("display", "granted");
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("display", call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("display", notificationPermissionState());
        call.resolve(result);
    }

    private String notificationPermissionState() {
        if (Build.VERSION.SDK_INT < 33) return "granted";
        int state = ContextCompat.checkSelfPermission(
            getContext(),
            Manifest.permission.POST_NOTIFICATIONS
        );
        return state == PackageManager.PERMISSION_GRANTED ? "granted" : "denied";
    }
}
