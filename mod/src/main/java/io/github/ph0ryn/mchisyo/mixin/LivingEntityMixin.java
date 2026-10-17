package io.github.ph0ryn.mchisyo.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(LivingEntity.class)
abstract class LivingEntityMixin {
    @WrapOperation(method = "drop(Lnet/minecraft/world/item/ItemStack;ZZ)Lnet/minecraft/world/entity/item/ItemEntity;",
            at = @At(value = "INVOKE", target = "Lnet/minecraft/world/level/Level;addFreshEntity(Lnet/minecraft/world/entity/Entity;)Z"))
    private boolean hisyo$insertedDrop(Level level, Entity entity, Operation<Boolean> original,
            ItemStack stack, boolean spread, boolean trace) {
        boolean succeeded = original.call(level, entity);
        ServerObservations.itemDropped((LivingEntity) (Object) this, entity, succeeded, spread, trace);
        return succeeded;
    }

    @Inject(method = "onEffectUpdated", at = @At("RETURN"))
    private void mcHisyo$effectUpdated(MobEffectInstance effect, boolean changed, Entity source, CallbackInfo ci) {
        ServerObservations.effectUpdated((LivingEntity) (Object) this, effect, changed);
    }
}
