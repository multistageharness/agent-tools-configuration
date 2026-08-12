package configdiscovery

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"
)

func TestEnvCoercion(t *testing.T) {
	cases := []struct {
		raw  string
		want any
	}{
		{"5432", int64(5432)},
		{"true", true},
		{"[1,2]", []any{int64(1), int64(2)}},
		{"5432abc", "5432abc"},
		{"1.5", 1.5},
	}
	for _, testCase := range cases {
		if got := coerceValue(testCase.raw, false); !reflect.DeepEqual(got, testCase.want) {
			t.Fatalf("%q: got %#v, want %#v", testCase.raw, got, testCase.want)
		}
	}
	if got := coerceValue("5432", true); got != "5432" {
		t.Fatalf("a quoted value must stay a string, got %#v", got)
	}
}

func TestEnvLayerMapping(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want map[string]any
	}{
		{
			name: "__ splits nesting",
			env:  map[string]string{"MYTOOL_LOG__LEVEL": "trace"},
			want: map[string]any{"log": map[string]any{"level": "trace"}},
		},
		{
			name: "a single underscore stays literal",
			env:  map[string]string{"MYTOOL_SOME_KEY": "1"},
			want: map[string]any{"some_key": int64(1)},
		},
		{
			name: "another prefix is ignored",
			env:  map[string]string{"OTHER_LOG__LEVEL": "trace", "PATH": "/usr/bin"},
			want: map[string]any{},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := envLayer(testCase.env, "MYTOOL", nil); !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("got %#v, want %#v", got, testCase.want)
			}
		})
	}
}

func TestEnvLayerWarnsOnAnEmptyKeyPath(t *testing.T) {
	var warnings []string
	envLayer(map[string]string{"MYTOOL_": "x"}, "MYTOOL", func(m string) { warnings = append(warnings, m) })
	if len(warnings) != 1 {
		t.Fatalf("expected a warning, got %v", warnings)
	}
}

func TestSourcesKeysAndOrder(t *testing.T) {
	sources := buildSources([]Layer{
		{Value: map[string]any{"b": 1, "a": 2}, Source: Source{Path: "/u/config.toml", Format: "toml", Precedence: 1}},
		{Value: map[string]any{}, Source: Source{Path: "/u/.env", Format: "dotenv", Precedence: 3}},
		{Value: map[string]any{"c": 3}, Source: Source{Path: "/p/config.toml", Format: "toml", Precedence: 2}},
	}, "")

	if !reflect.DeepEqual(sources[0].Keys, []string{"a", "b"}) {
		t.Fatalf("keys: got %v", sources[0].Keys)
	}
	// A file that parsed empty is still reported, with no keys.
	if len(sources[1].Keys) != 0 {
		t.Fatalf("expected an empty key list, got %v", sources[1].Keys)
	}
	// Application order, not sorted by precedence: a user-level .env belongs inside the user
	// root's block even though it outranks that root's structured files (SPEC section 3.1).
	got := []int{sources[0].Precedence, sources[1].Precedence, sources[2].Precedence}
	if !reflect.DeepEqual(got, []int{1, 3, 2}) {
		t.Fatalf("order: got %v", got)
	}
}

func TestSourcesEmptyKeysMarshalAsArrayNotNull(t *testing.T) {
	sources := buildSources([]Layer{
		{Value: map[string]any{}, Source: Source{Path: "/u/config.toml", Format: "toml", Precedence: 1}},
	}, "")
	encoded, err := json.Marshal(sources)
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"path":"/u/config.toml","format":"toml","precedence":1,"keys":[]}]`
	if string(encoded) != want {
		t.Fatalf("got %s\nwant %s", encoded, want)
	}
}

func TestSourcesRelativeTo(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "abs", "fixture")
	file := filepath.Join(root, "project", ".config", "mytool", "config.toml")
	sources := buildSources([]Layer{
		{Value: map[string]any{}, Source: Source{Path: file, Format: "toml", Precedence: 2}},
		{Value: map[string]any{"a": 1}, Source: Source{Path: "<env>", Format: "env", Precedence: 4}},
	}, root)

	if sources[0].Path != "project/.config/mytool/config.toml" {
		t.Fatalf("got %q", sources[0].Path)
	}
	// The labels are not paths and are passed through untouched.
	if sources[1].Path != "<env>" {
		t.Fatalf("got %q", sources[1].Path)
	}
}
