package io.github.ph0ryn.mchisyo.mixin;

import com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import io.github.ph0ryn.mchisyo.observation.ServerObservations;
import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.server.PlayerAdvancements;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;

@Mixin(PlayerAdvancements.class)
abstract class PlayerAdvancementsMixin {
    @Shadow private ServerPlayer player;
    @Shadow public abstract AdvancementProgress getOrStartProgress(AdvancementHolder advancement);

    @WrapMethod(method = "award")
    private boolean mcHisyo$award(AdvancementHolder advancement, String criterion, Operation<Boolean> original) {
        if (!ServerObservations.accepts(player)) return original.call(advancement, criterion);
        boolean beforeDone = getOrStartProgress(advancement).isDone();
        boolean granted = original.call(advancement, criterion);
        if (granted) ServerObservations.advancementAwarded(player, advancement.id().toString(), criterion,
                true, beforeDone, getOrStartProgress(advancement).isDone(), advancement.value().display().isPresent());
        return granted;
    }
}
