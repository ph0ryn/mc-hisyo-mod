package io.github.ph0ryn.mchisyo.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import java.util.OptionalInt;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.MenuProvider;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.EnderChestBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

@Mixin({ChestBlock.class, EnderChestBlock.class})
abstract class ChestBlockMixin {
    @WrapOperation(method = "useWithoutItem(Lnet/minecraft/world/level/block/state/BlockState;Lnet/minecraft/world/level/Level;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/entity/player/Player;Lnet/minecraft/world/phys/BlockHitResult;)Lnet/minecraft/world/InteractionResult;",
            at = @At(value = "INVOKE", target = "Lnet/minecraft/world/entity/player/Player;openMenu(Lnet/minecraft/world/MenuProvider;)Ljava/util/OptionalInt;"))
    private OptionalInt mcHisyo$position(Player receiver, MenuProvider provider, Operation<OptionalInt> original,
            BlockState state, Level level, BlockPos pos, Player player, BlockHitResult hit) {
        return receiver instanceof ServerPlayer serverPlayer
                ? ServerObservations.withMenuPosition(serverPlayer, pos, () -> original.call(receiver, provider))
                : original.call(receiver, provider);
    }
}
