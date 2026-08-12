package configdiscovery

// Struct binding - and the one place Viper is genuinely the right tool.
//
// Viper's case-insensitive key handling is a defect for loading (see loaders.go) and a feature
// here: a caller writing `LogLevel string` should bind a `logLevel` or a `log_level` from the
// file without decorating every field with a tag. So the merged map goes into a fresh Viper and
// comes back out through its mapstructure decoder.

import (
	"strings"

	"github.com/go-viper/mapstructure/v2"
	"github.com/spf13/viper"
)

// Unmarshal decodes the merged configuration into v, which must be a pointer to a struct or map.
//
// WeaklyTypedInput is deliberately off: a string where an int is expected is an error rather than
// a silent coercion. The spec already coerced at load time (SPEC section 4.5); coercing a second
// time here would hide the bug rather than surface it.
//
// When strict is true, a key with nowhere to go is reported as KindUnknownKey rather than
// ignored.
func (l *Loaded) Unmarshal(v any, opts ...UnmarshalOption) error {
	settings := &unmarshalSettings{}
	for _, apply := range opts {
		apply(settings)
	}

	binder := viper.New()
	if err := binder.MergeConfigMap(l.Config); err != nil {
		return &ConfigError{Kind: KindValidation, Message: err.Error(), Err: err}
	}

	err := binder.Unmarshal(v, func(decoder *mapstructure.DecoderConfig) {
		decoder.WeaklyTypedInput = false
		decoder.ErrorUnused = settings.strict
	})
	if err == nil {
		return nil
	}

	if settings.strict {
		if key, ok := unusedKeyOf(err); ok {
			return &ConfigError{
				Kind:    KindUnknownKey,
				KeyPath: key,
				Message: err.Error(),
				Err:     err,
			}
		}
	}
	return &ConfigError{Kind: KindValidation, Message: err.Error(), Err: err}
}

// UnmarshalOption configures Unmarshal.
type UnmarshalOption func(*unmarshalSettings)

type unmarshalSettings struct{ strict bool }

// UnmarshalStrict reports a key the target has no field for as KindUnknownKey.
func UnmarshalStrict() UnmarshalOption { return func(s *unmarshalSettings) { s.strict = true } }

// unusedKeyOf digs the offending key out of mapstructure's "invalid keys" message. mapstructure
// reports unused keys as prose inside a multi-error, with no structured field to read, so this
// is a parse - and it fails soft: a missed match still reports the error, just without the key
// path.
func unusedKeyOf(err error) (string, bool) {
	_, after, found := strings.Cut(err.Error(), "invalid keys: ")
	if !found {
		return "", false
	}
	key, _, _ := strings.Cut(strings.TrimSpace(after), ",")
	if key == "" {
		return "", false
	}
	return key, true
}
