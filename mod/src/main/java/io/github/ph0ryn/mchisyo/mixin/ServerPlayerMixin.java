package io.github.ph0ryn.mchisyo.mixin;

import com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.inventory.AbstractContainerMenu;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ServerPlayer.class)
abstract class ServerPlayerMixin {
    @Inject(method = "initMenu(Lnet/minecraft/world/inventory/AbstractContainerMenu;)V", at = @At("RETURN"))
    private void mcHisyo$initialized(AbstractContainerMenu menu, CallbackInfo ci) {
        ServerObservations.menuInitialized((ServerPlayer)(Object)this, menu);
    }

    @WrapMethod(method = "doCloseContainer()V")
    private void mcHisyo$closed(Operation<Void> original) {
        ServerPlayer player = (ServerPlayer)(Object)this;
        AbstractContainerMenu oldMenu = player.containerMenu;
        original.call();
        ServerObservations.menuClosed(player, oldMenu);
    }
}
