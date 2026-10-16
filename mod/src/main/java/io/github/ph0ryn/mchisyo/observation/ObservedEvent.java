package io.github.ph0ryn.mchisyo.observation;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Immutable, JSON-shaped server-thread fact. The bridge supplies scope/session/sequence. */
public record ObservedEvent(
        String name,
        String dimension,
        List<Double> position,
        long tick,
        long observedAt,
        Map<String, Object> data) {
    public ObservedEvent {
        Objects.requireNonNull(name);
        Objects.requireNonNull(dimension);
        position = copyPosition(position);
        if (tick < 0 || observedAt < 0) throw new IllegalArgumentException("Negative observation time");
        data = freezeMap(data);
    }

    static List<Double> copyPosition(List<Double> position) {
        List<Double> copy = List.copyOf(position);
        if (copy.size() != 3 || copy.stream().anyMatch(value -> !Double.isFinite(value))) {
            throw new IllegalArgumentException("Position requires three finite coordinates");
        }
        return copy;
    }

    private static Map<String, Object> freezeMap(Map<?, ?> source) {
        Map<String, Object> copy = new LinkedHashMap<>();
        source.forEach((key, value) -> {
            if (!(key instanceof String text)) throw new IllegalArgumentException("Non-string JSON key");
            copy.put(text, freeze(value));
        });
        // Map.copyOf rejects intentional JSON nulls (unknown damage entity / interaction hit).
        return Collections.unmodifiableMap(copy);
    }

    private static Object freeze(Object value) {
        if (value == null || value instanceof String || value instanceof Boolean) return value;
        if (value instanceof Number number) {
            if (!Double.isFinite(number.doubleValue())) throw new IllegalArgumentException("Non-finite JSON number");
            if (number instanceof Byte || number instanceof Short || number instanceof Integer
                    || number instanceof Long || number instanceof Float || number instanceof Double) return number;
        }
        if (value instanceof Map<?, ?> map) return freezeMap(map);
        if (value instanceof List<?> list) {
            List<Object> copy = new ArrayList<>(list.size());
            list.forEach(item -> copy.add(freeze(item)));
            return Collections.unmodifiableList(copy);
        }
        throw new IllegalArgumentException("Unsupported mutable/non-JSON observation value");
    }
}
