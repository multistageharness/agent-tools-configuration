package configdiscovery

// File loading - and the trap this whole package turns on.
//
// **Viper lowercases every key, at every depth.** viper.AllSettings() on a file containing
// `logLevel` under `[Nested]` returns `nested.loglevel`. The spec is case-sensitive, so routing
// values through Viper's key store destroys information before the merge ever runs.
//
// So the key store is bypassed. Per format:
//
//	toml   github.com/pelletier/go-toml/v2 - the parser Viper itself uses, decoded straight into
//	       map[string]any. NOT viper.AllSettings(): case preservation, not an oversight.
//	yaml   gopkg.in/yaml.v3 - same reasoning, same parser Viper uses.
//	json   encoding/json - the standard library; case is preserved for free.
//	jsonc  a comment-stripping pre-pass, then encoding/json.
//	ini    gopkg.in/ini.v1 - the parser Viper uses. Direct, so section names and keys keep their
//	       case; Viper's INI path would lowercase both.
//	dotenv github.com/joho/godotenv, plus a quote-aware second pass (see parseDotenv).
//
// Viper is still a load-bearing dependency of this package - it is what Loaded.Unmarshal uses to
// bind the merged map onto a struct, where its case-insensitive matching is a feature rather
// than a defect. See unmarshal.go.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
	toml "github.com/pelletier/go-toml/v2"
	ini "gopkg.in/ini.v1"
	yaml "gopkg.in/yaml.v3"
)

// positionPattern digs a line and column back out of a parser message for the parsers that only
// report it there. SPEC section 5 asks for the line where the parser offers one.
var positionPattern = regexp.MustCompile(`(?i)line (\d+)(?:[,: ]+column (\d+))?`)

func positionOf(err error) (line, column int) {
	var tomlErr *toml.DecodeError
	if errors.As(err, &tomlErr) {
		row, col := tomlErr.Position()
		return row, col
	}
	var yamlErr *yaml.TypeError
	if errors.As(err, &yamlErr) && len(yamlErr.Errors) > 0 {
		if match := positionPattern.FindStringSubmatch(yamlErr.Errors[0]); match != nil {
			return atoi(match[1]), atoi(match[2])
		}
	}
	if match := positionPattern.FindStringSubmatch(err.Error()); match != nil {
		return atoi(match[1]), atoi(match[2])
	}
	return 0, 0
}

func atoi(text string) int {
	value, err := strconv.Atoi(text)
	if err != nil {
		return 0
	}
	return value
}

func malformed(path string, err error) error {
	line, column := positionOf(err)
	return &ConfigError{
		Kind:    KindMalformed,
		Path:    path,
		Line:    line,
		Column:  column,
		Message: err.Error(),
		Err:     err,
	}
}

func readFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		// Permission, EISDIR, a broken symlink: a read failure, never a parse failure.
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) || os.IsPermission(err) {
			return nil, &ConfigError{
				Kind: KindUnreadable, Path: path, Message: err.Error(), Err: err,
			}
		}
		return nil, &ConfigError{Kind: KindUnreadable, Path: path, Message: err.Error(), Err: err}
	}
	return data, nil
}

// loadOne reads one file into a map with its original key case intact.
func loadOne(ref fileRef, envPrefix string) (map[string]any, error) {
	data, err := readFile(ref.path)
	if err != nil {
		return nil, err
	}

	switch ref.format {
	case "toml":
		var out map[string]any
		if err := toml.Unmarshal(data, &out); err != nil {
			return nil, malformed(ref.path, err)
		}
		return normalize(out), nil

	case "yaml":
		var out map[string]any
		if err := yaml.Unmarshal(data, &out); err != nil {
			return nil, malformed(ref.path, err)
		}
		return normalize(out), nil

	case "json", "jsonc":
		text := string(data)
		if ref.format == "jsonc" {
			text = stripJSONComments(text)
		}
		if strings.TrimSpace(text) == "" {
			return map[string]any{}, nil
		}
		var out any
		if err := json.Unmarshal([]byte(text), &out); err != nil {
			return nil, malformed(ref.path, err)
		}
		mapped, ok := out.(map[string]any)
		if !ok {
			return nil, &ConfigError{
				Kind:    KindMalformed,
				Path:    ref.path,
				Message: fmt.Sprintf("top level must be an object, not %T", out),
			}
		}
		return normalize(mapped), nil

	case "ini":
		file, err := ini.Load(data)
		if err != nil {
			return nil, malformed(ref.path, err)
		}
		return iniToMap(file), nil

	case "dotenv":
		return parseDotenv(string(data), envPrefix, ref.path)

	default:
		return nil, &ConfigError{
			Kind:    KindMalformed,
			Path:    ref.path,
			Message: "unhandled format " + ref.format,
		}
	}
}

// normalize converts whatever a parser produced into the canonical shape the merge works on:
// map[string]any, []any, and scalars. yaml.v3 in particular hands back map[string]any at the top
// level but its own types further down.
func normalize(value any) map[string]any {
	converted, _ := normalizeValue(value).(map[string]any)
	if converted == nil {
		return map[string]any{}
	}
	return converted
}

func normalizeValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeValue(item)
		}
		return out
	case map[any]any: // yaml.v2 shape, and yaml.v3 for non-string keys
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[fmt.Sprint(key)] = normalizeValue(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = normalizeValue(item)
		}
		return out
	default:
		return canonicalNumber(value)
	}
}

// canonicalNumber gives every source one numeric representation: int64 for an integral value,
// float64 otherwise.
//
// Without it the parsers disagree by construction - go-toml yields int64, encoding/json yields
// float64 for everything, yaml.v3 yields int - and a 5432 that came from a file would not be
// reflect.DeepEqual to a 5432 that came from an environment variable. Both still marshal as
// 5432, so the wire format is unaffected; what this buys is that the Go values a caller inspects
// are comparable regardless of which layer they came from.
func canonicalNumber(value any) any {
	const maxExactInteger = 1 << 53
	switch number := value.(type) {
	case float64:
		if number == math.Trunc(number) && !math.IsInf(number, 0) && math.Abs(number) < maxExactInteger {
			return int64(number)
		}
		return number
	case float32:
		return canonicalNumber(float64(number))
	case int:
		return int64(number)
	case int8:
		return int64(number)
	case int16:
		return int64(number)
	case int32:
		return int64(number)
	case uint:
		return int64(number)
	case uint8:
		return int64(number)
	case uint16:
		return int64(number)
	case uint32:
		return int64(number)
	case uint64:
		if number <= math.MaxInt64 {
			return int64(number)
		}
		return number
	default:
		return value
	}
}

// iniToMap flattens an ini.File, preserving section and key case. INI is an untyped format -
// every value arrives as text - so SPEC section 2.5 pins the same coercion the env layer uses.
func iniToMap(file *ini.File) map[string]any {
	out := map[string]any{}
	for _, section := range file.Sections() {
		target := out
		if section.Name() != ini.DefaultSection {
			nested := map[string]any{}
			out[section.Name()] = nested
			target = nested
		}
		for _, key := range section.Keys() {
			target[key.Name()] = coerceValue(key.Value(), false)
		}
	}
	return out
}

// stripJSONComments removes // and /* */ comments that are outside strings. Only those two
// forms, and only outside strings: this is a tolerant pre-pass for .jsonc, not a JSON5 parser.
func stripJSONComments(text string) string {
	var out strings.Builder
	inString := false
	for i := 0; i < len(text); {
		char := text[i]
		var next byte
		if i+1 < len(text) {
			next = text[i+1]
		}
		switch {
		case inString && char == '\\':
			out.WriteByte(char)
			if i+1 < len(text) {
				out.WriteByte(next)
			}
			i += 2
		case inString:
			if char == '"' {
				inString = false
			}
			out.WriteByte(char)
			i++
		case char == '"':
			inString = true
			out.WriteByte(char)
			i++
		case char == '/' && next == '/':
			for i < len(text) && text[i] != '\n' {
				i++
			}
		case char == '/' && next == '*':
			i += 2
			for i+1 < len(text) && !(text[i] == '*' && text[i+1] == '/') {
				i++
			}
			i += 2
		default:
			out.WriteByte(char)
			i++
		}
	}
	return out.String()
}

// parseDotenv maps a .env file by SPEC section 4.6.
//
// godotenv parses it, but godotenv - like every other .env reader in every ecosystem - strips
// surrounding quotes and cannot tell you it did. Section 4.6 gives quoting meaning: PORT=5432 is
// the number, PORT="5432" is the string. So the raw lines get a second pass to record which keys
// were written quoted.
func parseDotenv(text, envPrefix, path string) (map[string]any, error) {
	flat, err := godotenv.Unmarshal(text)
	if err != nil {
		return nil, malformed(path, err)
	}

	quoted := map[string]bool{}
	for _, rawLine := range strings.Split(text, "\n") {
		line := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(rawLine), "export "))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			quoted[strings.TrimSpace(name)] = true
		}
	}

	out := map[string]any{}
	marker := envPrefix + "_"
	for name, value := range flat {
		// The prefix is stripped when present and simply absent otherwise: a .env inside
		// .config/<packageName>/ is already unambiguous about which package it belongs to.
		bare := name
		if strings.HasPrefix(strings.ToUpper(name), marker) {
			bare = name[len(marker):]
		}
		path := envKeyPath(bare)
		if len(path) == 0 {
			continue
		}
		assignPath(out, path, coerceValue(value, quoted[name]))
	}
	return out, nil
}
