package configdiscovery

import (
	"testing"
)

type settings struct {
	LogLevel string `mapstructure:"logLevel"`
	Port     int    `mapstructure:"port"`
}

func TestUnmarshalIntoATaggedStruct(t *testing.T) {
	loaded := &Loaded{Config: map[string]any{"logLevel": "debug", "port": int64(5432)}}
	var target settings
	if err := loaded.Unmarshal(&target); err != nil {
		t.Fatal(err)
	}
	if target.LogLevel != "debug" || target.Port != 5432 {
		t.Fatalf("got %#v", target)
	}
}

func TestUnmarshalDoesNotWeaklyCoerce(t *testing.T) {
	// The spec already coerced at load time (SPEC section 4.5). Coercing a second time here
	// would hide the bug rather than surface it, so a string where an int belongs is an error.
	loaded := &Loaded{Config: map[string]any{"port": "5432"}}
	var target settings
	err := loaded.Unmarshal(&target)
	if !IsKind(err, KindValidation) {
		t.Fatalf("expected validation, got %v", err)
	}
}

func TestUnmarshalStrictReportsAnUnknownKey(t *testing.T) {
	loaded := &Loaded{Config: map[string]any{"port": int64(1), "mystery": true}}
	var target settings
	err := loaded.Unmarshal(&target, UnmarshalStrict())
	if !IsKind(err, KindUnknownKey) {
		t.Fatalf("expected unknown-key, got %v", err)
	}
	var configError *ConfigError
	if !asConfigError(err, &configError) || configError.KeyPath == "" {
		t.Fatalf("expected a key path, got %#v", configError)
	}
}

func TestUnmarshalIgnoresUnknownKeysByDefault(t *testing.T) {
	loaded := &Loaded{Config: map[string]any{"port": int64(1), "mystery": true}}
	var target settings
	if err := loaded.Unmarshal(&target); err != nil {
		t.Fatal(err)
	}
}

func TestConfigErrorMessageAndUnwrap(t *testing.T) {
	cases := []Kind{
		KindNotFound, KindUnreadable, KindMalformed,
		KindDuplicateFormat, KindUnknownKey, KindValidation,
	}
	for _, kind := range cases {
		err := error(&ConfigError{Kind: kind, Path: "/x/config.toml", Line: 3, Message: "boom"})
		if !IsKind(err, kind) {
			t.Fatalf("IsKind failed for %q", kind)
		}
		var target *ConfigError
		if !asConfigError(err, &target) || target.Kind != kind {
			t.Fatalf("errors.As failed for %q", kind)
		}
		if got := err.Error(); got == "" {
			t.Fatalf("empty message for %q", kind)
		}
	}
}
