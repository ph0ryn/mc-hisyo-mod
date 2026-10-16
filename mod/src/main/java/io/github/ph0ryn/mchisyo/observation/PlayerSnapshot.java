package io.github.ph0ryn.mchisyo.observation;

import java.util.List;
import java.util.Objects;

/** Copied values only: no ItemStack, entity, level, or other Minecraft runtime references. */
public record PlayerSnapshot(
        String dimension,
        List<Double> position,
        String biomeId,
        long tick,
        long observedAt,
        List<Item> inventory,
        double health,
        int foodLevel,
        double saturation,
        int experienceLevel,
        double experienceProgress,
        int totalExperience,
        int selectedSlot,
        Item mainHand,
        Item offHand) {
    public PlayerSnapshot {
        Objects.requireNonNull(dimension);
        position = ObservedEvent.copyPosition(position);
        inventory = List.copyOf(inventory);
        Objects.requireNonNull(mainHand);
        Objects.requireNonNull(offHand);
    }

    /** ID/count snapshots intentionally omit component-only changes. Empty stacks use air/0. */
    public record Item(String itemId, int count) {
        public Item {
            Objects.requireNonNull(itemId);
            if (count < 0) throw new IllegalArgumentException("Negative item count");
        }
    }
}
