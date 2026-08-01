package com.apiinphone.client;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

@CapacitorPlugin(name = "PythonSandbox")
public class PythonSandboxPlugin extends Plugin {

    /** Handles Capacitor calls without blocking the WebView bridge thread. */
    private final ExecutorService bridgeExecutor = Executors.newCachedThreadPool();
    /** Serializes Python execution (interpreter is not fully re-entrant). */
    private final ExecutorService pythonExecutor = Executors.newSingleThreadExecutor();
    private final Object pythonLock = new Object();

    private void ensurePythonStarted() {
        synchronized (pythonLock) {
            if (!Python.isStarted()) {
                Python.start(new AndroidPlatform(getContext()));
            }
        }
    }

    @PluginMethod
    public void run(PluginCall call) {
        String code = call.getString("code", "");
        if (code == null) {
            code = "";
        }
        Integer timeoutSec = call.getInt("timeoutSec", 15);
        int timeout = timeoutSec == null ? 15 : Math.min(120, Math.max(3, timeoutSec));
        final String userCode = code;

        bridgeExecutor.execute(() -> {
            try {
                ensurePythonStarted();
                Future<String> future = pythonExecutor.submit(new Callable<String>() {
                    @Override
                    public String call() {
                        Python py = Python.getInstance();
                        PyObject module = py.getModule("sandbox_runner");
                        PyObject result = module.callAttr("run", userCode);
                        return result == null ? "(无输出)" : result.toString();
                    }
                });

                String output;
                try {
                    output = future.get(timeout, TimeUnit.SECONDS);
                } catch (TimeoutException e) {
                    future.cancel(true);
                    call.reject("执行超时。");
                    return;
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause() != null ? e.getCause() : e;
                    String message = cause.getMessage() != null ? cause.getMessage() : cause.toString();
                    call.reject("Python 执行失败：" + message);
                    return;
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    future.cancel(true);
                    call.reject("执行被中断。");
                    return;
                }

                JSObject ret = new JSObject();
                ret.put("output", output != null ? output : "(无输出)");
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("无法运行 Python：" + e.getMessage());
            }
        });
    }
}
