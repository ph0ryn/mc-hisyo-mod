package io.github.ph0ryn.mchisyo.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.FurnaceResultSlot;
import net.minecraft.world.inventory.Slot;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

@Mixin(AbstractContainerMenu.class)
abstract class AbstractContainerMenuMixin {
    @WrapOperation(method = "doClick", at = @At(value = "INVOKE", target =
            "Lnet/minecraft/world/inventory/Slot;onSwapCraft(I)V"))
    private void hisyo$furnaceSwap(Slot slot, int count, Operation<Void> original,
            int slotId, int button, ClickType click, Player source) {
        original.call(slot, count);
        // Only this empty-hotbar branch has already assigned output but has not yet cleared the slot.
        // FurnaceResultSlot inherits the no-op onSwapCraft; its removeCount stays zero, so onTake cannot duplicate this.
        if (slot instanceof FurnaceResultSlot && source instanceof ServerPlayer player && ServerObservations.accepts(player)) {
            ServerObservations.resultTaken(player, slot, slot.getItem(), count, true);
        }
    }
}
