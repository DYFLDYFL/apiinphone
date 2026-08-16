package com.apiinphone.client;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Native HTTP via OkHttp. Android WebView fetch 对跨域（CORS）与流式响应体支持
 * 不可靠（opencode go 网关无 CORS），聊天/模型请求以本插件为主通道。
 *
 * 协议策略：先走 HTTP/1.1（与可用的 Vite 同源代理同路径）；仅网络层异常时
 * 回退默认客户端（可协商 HTTP/2）重试一次。曾误诊「go 网关只接受 HTTP/2」，
 * 实测 HTTP/1.1 正常（Cloudflare 边缘），勿再改回。
 */
@CapacitorPlugin(name = "HttpNative")
public class HttpNativePlugin extends Plugin {

    private static final ConcurrentHashMap<String, Call> ACTIVE = new ConcurrentHashMap<>();

    private static OkHttpClient client(int timeoutMs, boolean http11) {
        OkHttpClient.Builder builder = new OkHttpClient.Builder()
                .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS);
        if (http11) {
            builder.protocols(Arrays.asList(Protocol.HTTP_1_1));
        }
        return builder.build();
    }

    private static Request buildRequest(PluginCall call) {
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers");
        String body = call.getString("body");

        Request.Builder builder = new Request.Builder().url(url);
        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                builder.header(key, headers.getString(key));
            }
        }
        RequestBody requestBody = null;
        if (body != null) {
            // OkHttp BridgeInterceptor 会用 body.contentType() 覆盖 Content-Type 头
            // （header() 为替换语义）。若 body 固定为 text/plain，网关会收到
            // Content-Type: text/plain 而 415（go 网关实测）。必须按请求头的
            // Content-Type 创建 body，缺省 application/json。
            String contentType = headers != null ? headers.getString("Content-Type") : null;
            MediaType media = null;
            if (contentType != null) {
                try {
                    media = MediaType.parse(contentType);
                } catch (Exception ignored) {
                    media = null;
                }
            }
            if (media == null) {
                media = MediaType.parse("application/json; charset=utf-8");
            }
            requestBody = RequestBody.create(body, media);
        }
        String m = method.toUpperCase();
        switch (m) {
            case "POST":
                builder.post(requestBody);
                break;
            case "PUT":
                builder.put(requestBody);
                break;
            case "PATCH":
                builder.patch(requestBody);
                break;
            case "DELETE":
                builder.delete(requestBody);
                break;
            default:
                builder.get();
                break;
        }
        return builder.build();
    }

    private static String errorOf(Exception e) {
        return e.getMessage() == null ? e.toString() : e.getMessage();
    }

    @PluginMethod
    public void httpText(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url 必填");
            return;
        }
        final int timeoutMs = call.getInt("timeoutMs", 15000);
        Thread worker = new Thread(() -> {
            try {
                Request request = buildRequest(call);
                Response response = executeWithFallback(request, timeoutMs);
                try {
                    String text = response.body() != null ? response.body().string() : "";
                    JSObject result = new JSObject();
                    result.put("status", response.code());
                    result.put("text", text);
                    call.resolve(result);
                } finally {
                    response.close();
                }
            } catch (Exception e) {
                JSObject result = new JSObject();
                result.put("error", errorOf(e));
                call.resolve(result);
            }
        });
        worker.start();
    }

    /** 流式请求：逐行读取响应体并通过 httpChunk 事件推送（SSE 用）。 */
    @PluginMethod
    public void httpStream(final PluginCall call) {
        final String requestId = call.getString("requestId", "");
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url 必填");
            return;
        }
        final int timeoutMs = call.getInt("timeoutMs", 15000);
        call.setKeepAlive(true);
        Thread worker = new Thread(() -> {
            try {
                Request request = buildRequest(call);
                Call current = client(timeoutMs, true).newCall(request);
                ACTIVE.put(requestId, current);
                Response response;
                try {
                    response = current.execute();
                } catch (IOException e1) {
                    // HTTP/1.1 网络层失败：换默认客户端（HTTP/2 可协商）重试一次。
                    ACTIVE.remove(requestId);
                    current = client(timeoutMs, false).newCall(request);
                    ACTIVE.put(requestId, current);
                    try {
                        response = current.execute();
                    } catch (IOException e2) {
                        ACTIVE.remove(requestId);
                        JSObject result = new JSObject();
                        result.put("error", errorOf(e2));
                        call.resolve(result);
                        return;
                    }
                }
                try {
                    if (!response.isSuccessful()) {
                        String body = response.body() != null ? response.body().string() : "";
                        JSObject result = new JSObject();
                        result.put("error", "HTTP " + response.code() + ": " + body);
                        call.resolve(result);
                        return;
                    }
                    BufferedReader reader = new BufferedReader(
                            new InputStreamReader(response.body().byteStream(), StandardCharsets.UTF_8));
                    String line;
                    // 不能以 call.isSaved() 作为终止条件：setKeepAlive(true) 后该标志
                    // 恒为 true（Capacitor 实现即 keepAlive 标志），会在第一行就 break。
                    // 终止只靠 EOF；取消由 httpAbort -> cancel() -> 读抛出 IOException 处理。
                    while ((line = reader.readLine()) != null) {
                        if (line.isEmpty()) continue;
                        JSObject chunk = new JSObject();
                        chunk.put("requestId", requestId);
                        chunk.put("chunk", line + "\n");
                        notifyListeners("httpChunk", chunk);
                    }
                    reader.close();
                    call.resolve(new JSObject());
                } finally {
                    response.close();
                }
            } catch (Exception e) {
                // 取消/超时/异常都必须 resolve，否则 JS 侧 promise 永不 settle（卡死、停止无效）。
                JSObject result = new JSObject();
                result.put("error", errorOf(e));
                call.resolve(result);
            } finally {
                ACTIVE.remove(requestId);
            }
        });
        worker.start();
    }

    /** 中止进行中的 httpStream（requestId 匹配）。 */
    @PluginMethod
    public void httpAbort(final PluginCall call) {
        String requestId = call.getString("requestId", "");
        Call current = ACTIVE.remove(requestId);
        if (current != null) current.cancel();
        call.resolve();
    }

    /** 先 HTTP/1.1；仅网络层异常时用 HTTP/2 可协商客户端重试一次。 */
    private static Response executeWithFallback(Request request, int timeoutMs) throws IOException {
        try {
            return client(timeoutMs, true).newCall(request).execute();
        } catch (IOException first) {
            return client(timeoutMs, false).newCall(request).execute();
        }
    }
}
