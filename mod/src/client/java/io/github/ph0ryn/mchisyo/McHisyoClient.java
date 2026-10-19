package io.github.ph0ryn.mchisyo;

import net.fabricmc.api.ClientModInitializer;

/** Client-only entry point for hisyo in local singleplayer. */
public final class McHisyoClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        new HisyoClient(net.minecraft.client.Minecraft.getInstance(),
                net.fabricmc.loader.api.FabricLoader.getInstance().getConfigDir());
    }
}
