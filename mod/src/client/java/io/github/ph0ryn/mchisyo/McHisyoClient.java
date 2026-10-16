package io.github.ph0ryn.mchisyo;

import net.fabricmc.api.ClientModInitializer;

/** Client-only entry point for the local singleplayer Director. */
public final class McHisyoClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        new DirectorClient(net.minecraft.client.Minecraft.getInstance(),
                net.fabricmc.loader.api.FabricLoader.getInstance().getConfigDir());
    }
}
