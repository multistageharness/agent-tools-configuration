package configdiscovery

// Merge semantics - SPEC section 4.
//
// viper.MergeInConfig does not implement it: it merges into a lowercased key store and has its
// own opinion about slices. So the merge is written here, structurally mirroring the TypeScript
// and Python implementations - three comparable implementations make a fixture disagreement far
// cheaper to adjudicate than three merely correct ones.

import "sort"

// Layer is one layer on its way into the merge, with the source it will be reported as.
type Layer struct {
	Value  map[string]any
	Source Source
	// Root is the config directory this layer came from, for first-match. Empty for the layers
	// that belong to no root: defaults, env, overrides.
	Root string
}

type mergeOptions struct {
	arrayMerge string
	warn       func(string)
}

// deepCopy prevents a layer's map from being aliased into the result and then mutated by a later
// layer - or by the caller.
func deepCopy(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = deepCopy(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = deepCopy(item)
		}
		return out
	default:
		return value
	}
}

func mergeInto(lower, higher map[string]any, o mergeOptions, path string) map[string]any {
	out := make(map[string]any, len(lower)+len(higher))
	for key, value := range lower {
		out[key] = value
	}

	// Ranging yields only the keys the higher layer actually has, which is what keeps absent and
	// null apart: a key that is present with a nil value asks for a delete, a key that is not
	// there at all says nothing. Never test presence with out[key] != nil.
	keys := make([]string, 0, len(higher))
	for key := range higher {
		keys = append(keys, key)
	}
	sort.Strings(keys) // Deterministic warning order; the result is a map either way.

	for _, key := range keys {
		value := higher[key]
		at := key
		if path != "" {
			at = path + "." + key
		}

		// SPEC section 4.4: an explicit null in a higher layer removes the key.
		if value == nil {
			delete(out, key)
			continue
		}

		existing, present := out[key]
		existingMap, existingIsMap := existing.(map[string]any)
		valueMap, valueIsMap := value.(map[string]any)
		if present && existingIsMap && valueIsMap {
			out[key] = mergeInto(existingMap, valueMap, o, at)
			continue
		}

		existingSlice, existingIsSlice := existing.([]any)
		valueSlice, valueIsSlice := value.([]any)
		if present && existingIsSlice && valueIsSlice {
			// SPEC section 4.3: replace by default; concat appends and never deduplicates.
			if o.arrayMerge == "concat" {
				combined := make([]any, 0, len(existingSlice)+len(valueSlice))
				combined = append(combined, existingSlice...)
				combined = append(combined, valueSlice...)
				out[key] = deepCopy(combined)
			} else {
				out[key] = deepCopy(valueSlice)
			}
			continue
		}

		if present && o.warn != nil && existingIsMap != valueIsMap {
			was, now := "a scalar", "a scalar"
			if existingIsMap {
				was = "a map"
			}
			if valueIsMap {
				now = "a map"
			}
			o.warn(at + ": replacing " + was + " with " + now + " (SPEC section 4.2)")
		}
		out[key] = deepCopy(value)
	}
	return out
}

// mergeLayers folds the layers lowest precedence first.
func mergeLayers(layers []Layer, o mergeOptions) map[string]any {
	result := map[string]any{}
	for _, layer := range layers {
		if layer.Value == nil {
			continue
		}
		result = mergeInto(result, layer.Value, o, "")
	}
	return result
}

// applyStrategy implements SPEC section 3.2.
//
// Under first-match only the highest-precedence root that contributed a file survives - the
// lower roots are dropped from the merge *and* from sources, because the option means "the
// others were never consulted", not "the others lost". The rootless layers - defaults, env,
// overrides - always survive: the option scopes the file layers only.
func applyStrategy(layers []Layer, strategy string) []Layer {
	if strategy != "first-match" {
		return layers
	}
	winning := ""
	for _, layer := range layers {
		if layer.Root != "" {
			winning = layer.Root
		}
	}
	kept := make([]Layer, 0, len(layers))
	for _, layer := range layers {
		if layer.Root == "" || layer.Root == winning {
			kept = append(kept, layer)
		}
	}
	return kept
}
