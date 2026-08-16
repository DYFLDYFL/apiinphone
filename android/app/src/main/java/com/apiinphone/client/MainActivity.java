package com.apiinphone.client;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChatKeepAlivePlugin.class);
        registerPlugin(PythonSandboxPlugin.class);
        registerPlugin(HttpNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
