package io.github.ph0ryn.mchisyo.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.gameevent.GameEvent;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

@Mixin(BlockItem.class)
abstract class BlockItemMixin {
    @WrapOperation(method = "place", at = @At(value = "INVOKE", target =
            "Lnet/minecraft/world/level/Level;gameEvent(Lnet/minecraft/core/Holder;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/gameevent/GameEvent$Context;)V"))
    private void hisyo$placed(Level level, Holder<GameEvent> event, BlockPos pos, GameEvent.Context context,
            Operation<Void> original) {
        original.call(level, event, pos, context);
        ServerObservations.blockPlaced((BlockItem) (Object) this, pos, context);
    }
}
