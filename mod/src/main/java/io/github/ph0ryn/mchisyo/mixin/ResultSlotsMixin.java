package io.github.ph0ryn.mchisyo.mixin;

import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.FurnaceResultSlot;
import net.minecraft.world.inventory.ResultSlot;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin({ResultSlot.class, FurnaceResultSlot.class})
abstract class ResultSlotsMixin {
    // The two 1.21.11 targets share named fields but have different intermediary names.
    // Explicit private aliases keep Loom from choosing one target's mapping for both.
    @Shadow(remap = false, aliases = {"player", "field_7868", "field_7818"})
    @Final private Player hisyo$player;
    @Shadow(remap = false, aliases = {"removeCount", "field_7869", "field_7819"})
    private int hisyo$removeCount;

    @Inject(method = "checkTakeAchievements", at = @At("HEAD"))
    private void hisyo$credited(ItemStack output, CallbackInfo ci) {
        if (hisyo$player instanceof ServerPlayer serverPlayer && ServerObservations.accepts(serverPlayer)) {
            ServerObservations.resultTaken(serverPlayer, (Slot) (Object) this, output, hisyo$removeCount,
                    (Object) this instanceof FurnaceResultSlot);
        }
    }
}
