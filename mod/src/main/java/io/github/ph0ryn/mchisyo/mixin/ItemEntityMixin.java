package io.github.ph0ryn.mchisyo.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

@Mixin(ItemEntity.class)
abstract class ItemEntityMixin {
    @WrapOperation(method = "playerTouch", at = @At(value = "INVOKE", target =
            "Lnet/minecraft/world/entity/player/Inventory;add(Lnet/minecraft/world/item/ItemStack;)Z"))
    private boolean hisyo$consumed(Inventory inventory, ItemStack stack, Operation<Boolean> original, Player source) {
        if (!(source instanceof ServerPlayer player) || !ServerObservations.accepts(player)) {
            return original.call(inventory, stack);
        }
        String itemId = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
        int before = stack.getCount();
        boolean succeeded = original.call(inventory, stack);
        // Capture here: playerTouch later restores the original count after a full pickup.
        ServerObservations.itemPickedUp(player, (ItemEntity) (Object) this, itemId, before, stack.getCount());
        return succeeded;
    }
}
