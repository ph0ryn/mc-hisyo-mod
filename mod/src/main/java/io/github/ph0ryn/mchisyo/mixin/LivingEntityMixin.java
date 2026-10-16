package io.github.ph0ryn.mchisyo.mixin;

import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(LivingEntity.class)
abstract class LivingEntityMixin {
    @Inject(method = "onEffectUpdated", at = @At("RETURN"))
    private void mcHisyo$effectUpdated(MobEffectInstance effect, boolean changed, Entity source, CallbackInfo ci) {
        ServerObservations.effectUpdated((LivingEntity) (Object) this, effect, changed);
    }
}
