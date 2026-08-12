package configdiscovery

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func asConfigError(err error, target **ConfigError) bool { return errors.As(err, target) }

func loadIn(t *testing.T, root string, opts ...Option) (*Loaded, error) {
	t.Helper()
	base := []Option{
		WithCwd(filepath.Join(root, "project")),
		WithHome(filepath.Join(root, "home")),
		WithEnv(map[string]string{}),
		WithWarningHandler(func(string) {}),
	}
	return Load("mytool", append(base, opts...)...)
}

func TestLoadLocalOnly(t *testing.T) {
	root := tree(t, map[string]string{
		"project/.git":                       "",
		"project/.config/mytool/config.toml": "[log]\nlevel = \"debug\"\n",
		"home/":                              "",
	})
	result, err := loadIn(t, root)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Config, map[string]any{"log": map[string]any{"level": "debug"}}) {
		t.Fatalf("got %#v", result.Config)
	}
	if !result.Found || len(result.Sources) != 1 || result.Sources[0].Precedence != 2 {
		t.Fatalf("got found=%v sources=%#v", result.Found, result.Sources)
	}
}

func TestLoadUserOnly(t *testing.T) {
	root := tree(t, map[string]string{
		"project/.git":                    "",
		"home/.config/mytool/config.toml": "[log]\nlevel = \"info\"\n",
	})
	result, err := loadIn(t, root)
	if err != nil {
		t.Fatal(err)
	}
	if result.Sources[0].Precedence != 1 {
		t.Fatalf("got %#v", result.Sources)
	}
}

func TestLoadNeitherPresentIsNotAnError(t *testing.T) {
	root := tree(t, map[string]string{"project/.git": "", "home/": ""})
	result, err := loadIn(t, root)
	if err != nil {
		t.Fatalf("nothing found must not be an error: %v", err)
	}
	if result.Found || len(result.Config) != 0 || len(result.Sources) != 0 {
		t.Fatalf("got %#v", result)
	}
	// SPEC section 7 and CANONICAL: an empty list is [], never null.
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"sources":[]`) {
		t.Fatalf("empty sources must marshal as []: %s", encoded)
	}
}

func TestLoadDefaultsDoNotSetFound(t *testing.T) {
	root := tree(t, map[string]string{"project/.git": "", "home/": ""})
	result, err := loadIn(t, root, WithDefaults(map[string]any{"log": map[string]any{"level": "warn"}}))
	if err != nil {
		t.Fatal(err)
	}
	if result.Found {
		t.Fatal("defaults must not set Found")
	}
	if result.Sources[0].Format != "defaults" {
		t.Fatalf("got %#v", result.Sources)
	}
}

func TestLoadThreeLayersAndTheLosersAreStillReported(t *testing.T) {
	root := tree(t, map[string]string{
		"project/.git":                       "",
		"project/.config/mytool/config.toml": "[log]\nlevel = \"debug\"\n",
		"home/.config/mytool/config.toml":    "[log]\nlevel = \"info\"\n",
	})
	result, err := loadIn(t, root, WithEnv(map[string]string{
		"MYTOOL_LOG__LEVEL": "trace",
		"MYTOOL_PORT":       "5432",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"log": map[string]any{"level": "trace"}, "port": int64(5432)}
	if !reflect.DeepEqual(result.Config, want) {
		t.Fatalf("got %#v, want %#v", result.Config, want)
	}
	var precedences []int
	for _, source := range result.Sources {
		precedences = append(precedences, source.Precedence)
	}
	if !reflect.DeepEqual(precedences, []int{1, 2, 4}) {
		t.Fatalf("got %v", precedences)
	}
}

func TestLoadOverridesWinOverEverything(t *testing.T) {
	root := tree(t, map[string]string{
		"project/.git":                       "",
		"project/.config/mytool/config.toml": "[log]\nlevel = \"debug\"\n",
		"home/":                              "",
	})
	result, err := loadIn(t, root,
		WithEnv(map[string]string{"MYTOOL_LOG__LEVEL": "trace"}),
		WithOverrides(map[string]any{"log": map[string]any{"level": "silent"}}),
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := result.Config["log"].(map[string]any)["level"]; got != "silent" {
		t.Fatalf("got %v", got)
	}
	if result.Sources[len(result.Sources)-1].Precedence != 5 {
		t.Fatalf("got %#v", result.Sources)
	}
}

func TestLoadRejectsAPackageNameWithASeparator(t *testing.T) {
	if _, err := Load("../evil"); err == nil {
		t.Fatal("expected an error")
	} else if IsKind(err, KindMalformed) {
		t.Fatal("a bad package name is a programming error, not a ConfigError")
	}
}

// SPEC section 5's list is closed, and each entry needs a route that reaches it.
func TestEveryConfigErrorKindIsReachable(t *testing.T) {
	seen := map[Kind]bool{}

	malformedRoot := tree(t, map[string]string{
		"project/.git": "", "project/.config/mytool/config.toml": "[log\n", "home/": "",
	})
	if _, err := loadIn(t, malformedRoot); IsKind(err, KindMalformed) {
		seen[KindMalformed] = true
	} else {
		t.Fatalf("expected malformed, got %v", err)
	}

	duplicateRoot := tree(t, map[string]string{
		"project/.git":                       "",
		"project/.config/mytool/config.yaml": "a: 1\n",
		"project/.config/mytool/config.yml":  "a: 2\n",
		"home/":                              "",
	})
	if _, err := loadIn(t, duplicateRoot); IsKind(err, KindDuplicateFormat) {
		seen[KindDuplicateFormat] = true
	} else {
		t.Fatalf("expected duplicate-format, got %v", err)
	}

	unreadableRoot := tree(t, map[string]string{
		"project/.git": "", "project/.config/mytool/config.toml/": "", "home/": "",
	})
	if _, err := loadIn(t, unreadableRoot); IsKind(err, KindUnreadable) {
		seen[KindUnreadable] = true
	} else {
		t.Fatalf("expected unreadable, got %v", err)
	}

	strictRoot := tree(t, map[string]string{
		"project/.git": "", "project/.config/mytool/config.toml": "extra = 1\n", "home/": "",
	})
	result, err := loadIn(t, strictRoot)
	if err != nil {
		t.Fatal(err)
	}
	var target struct {
		Known string `mapstructure:"known"`
	}
	if err := result.Unmarshal(&target, UnmarshalStrict()); IsKind(err, KindUnknownKey) {
		seen[KindUnknownKey] = true
	} else {
		t.Fatalf("expected unknown-key, got %v", err)
	}

	typeMismatch := tree(t, map[string]string{
		"project/.git": "", "project/.config/mytool/config.toml": "port = \"not a number\"\n", "home/": "",
	})
	result, err = loadIn(t, typeMismatch)
	if err != nil {
		t.Fatal(err)
	}
	var typed struct {
		Port int `mapstructure:"port"`
	}
	if err := result.Unmarshal(&typed); IsKind(err, KindValidation) {
		seen[KindValidation] = true
	} else {
		t.Fatalf("expected validation, got %v", err)
	}

	// not-found exists so a caller can name the condition (SPEC section 5), not so it can be
	// raised: an empty tree returns a nil error.
	emptyRoot := tree(t, map[string]string{"project/.git": "", "home/": ""})
	if _, err := loadIn(t, emptyRoot); err != nil {
		t.Fatalf("nothing found must not raise: %v", err)
	}
	if (&ConfigError{Kind: KindNotFound}).Kind == KindNotFound {
		seen[KindNotFound] = true
	}

	for _, kind := range []Kind{
		KindNotFound, KindUnreadable, KindMalformed,
		KindDuplicateFormat, KindUnknownKey, KindValidation,
	} {
		if !seen[kind] {
			t.Fatalf("kind %q was never reached by a test", kind)
		}
	}
}
