package configdiscovery

// The environment-variable layer - SPEC section 4.5 - and the name mapping .env files share with
// it (SPEC section 4.6).
//
// **Viper's AutomaticEnv and SetEnvPrefix are deliberately not used.** Viper keeps environment
// values as strings and defers coercion to read time (GetInt, GetBool), which is a different
// model from the spec's coerce-at-load - and it reads the process environment directly, so a
// fixture's result would depend on the developer's shell. If a later reader "simplifies" this
// file back onto AutomaticEnv, the env-var-beats-files fixture is what will break, and it will
// break by producing the string "5432" where the number 5432 is required.
//
// The numeric-parity detail: encoding/json decodes every number to float64, so this layer must
// produce float64 too. A 5432 that came from a file and a 5432 that came from an env var have to
// be reflect.DeepEqual, or the merge treats them as different values.

import (
	"encoding/json"
	"strings"
)

// envKeyPath maps a variable name, prefix already stripped, to a key path: lowercase, split on
// "__", and leave a single "_" alone. SOME_KEY is the single key some_key, not some.key.
func envKeyPath(name string) []string {
	var path []string
	for _, segment := range strings.Split(strings.ToLower(name), "__") {
		if segment != "" {
			path = append(path, segment)
		}
	}
	return path
}

// coerceValue is SPEC section 4.5 step 5: parse as JSON, keep the raw string when that fails.
// wasQuoted short-circuits it for .env values written inside quotes, which section 4.6 keeps as
// strings.
func coerceValue(raw string, wasQuoted bool) any {
	if wasQuoted {
		return raw
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return raw
	}
	// Through the same normalization the file loaders use, so an integer from an environment
	// variable is the same Go type as an integer from a TOML file.
	return normalizeValue(value)
}

// assignPath writes value at path, creating maps along the way and replacing non-maps.
func assignPath(target map[string]any, path []string, value any) {
	if len(path) == 0 {
		return
	}
	node := target
	for _, segment := range path[:len(path)-1] {
		child, ok := node[segment].(map[string]any)
		if !ok {
			child = map[string]any{}
			node[segment] = child
		}
		node = child
	}
	node[path[len(path)-1]] = value
}

// envLayer is layer 4. env is a parameter and is never os.Environ() in here: the probe and every
// test depend on an exported MYTOOL_* in the developer's shell being unable to reach it.
func envLayer(env map[string]string, prefix string, warn func(string)) map[string]any {
	out := map[string]any{}
	marker := prefix + "_"
	for name, raw := range env {
		if !strings.HasPrefix(name, marker) {
			continue
		}
		path := envKeyPath(name[len(marker):])
		if len(path) == 0 {
			if warn != nil {
				warn("ignoring " + name + ": it maps to an empty key path")
			}
			continue
		}
		assignPath(out, path, coerceValue(raw, false))
	}
	return out
}
