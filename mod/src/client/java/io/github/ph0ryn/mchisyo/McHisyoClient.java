package io.github.ph0ryn.mchisyo;

import net.fabricmc.api.ClientModInitializer;

/** Client entry point; the foundation build does not register gameplay behavior. */
public final class McHisyoClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        // Observation and transport are implemented after the build gate is verified.
    }
}
