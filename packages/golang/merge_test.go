package configdiscovery

import (
	"reflect"
	"testing"
)

func layer(value map[string]any, root string, precedence int) Layer {
	path := "<env>"
	format := "env"
	if root != "" {
		path = root + "/config.toml"
		format = "toml"
	}
	return Layer{
		Value:  value,
		Root:   root,
		Source: Source{Path: path, Format: format, Precedence: precedence},
	}
}

// These mirror the conformance fixtures one to one, so a unit failure and a conformance failure
// point at the same clause of SPEC.
func TestMergeFixtureCases(t *testing.T) {
	cases := []struct {
		name       string
		layers     []Layer
		arrayMerge string
		want       map[string]any
	}{
		{
			name: "both-scalar-conflict",
			layers: []Layer{
				layer(map[string]any{"log": map[string]any{"level": "info"}}, "/user", 1),
				layer(map[string]any{"log": map[string]any{"level": "debug"}}, "/project", 2),
			},
			want: map[string]any{"log": map[string]any{"level": "debug"}},
		},
		{
			name: "both-nested-map-merge",
			layers: []Layer{
				layer(map[string]any{"database": map[string]any{"host": "db.example.com", "port": int64(5432)}}, "/user", 1),
				layer(map[string]any{"database": map[string]any{"port": int64(6543)}}, "/project", 2),
			},
			want: map[string]any{"database": map[string]any{"host": "db.example.com", "port": int64(6543)}},
		},
		{
			name: "both-array-replace",
			layers: []Layer{
				layer(map[string]any{"plugins": []any{"a", "b"}}, "/user", 1),
				layer(map[string]any{"plugins": []any{"c"}}, "/project", 2),
			},
			want: map[string]any{"plugins": []any{"c"}},
		},
		{
			name: "both-array-concat keeps duplicates",
			layers: []Layer{
				layer(map[string]any{"plugins": []any{"a", "b"}}, "/user", 1),
				layer(map[string]any{"plugins": []any{"b", "c"}}, "/project", 2),
			},
			arrayMerge: "concat",
			want:       map[string]any{"plugins": []any{"a", "b", "b", "c"}},
		},
		{
			name: "explicit-null-unsets",
			layers: []Layer{
				layer(map[string]any{"a": int64(1)}, "/user", 1),
				layer(map[string]any{"a": nil}, "/project", 2),
			},
			want: map[string]any{},
		},
		{
			name: "an absent key is not a null key",
			layers: []Layer{
				layer(map[string]any{"a": int64(1)}, "/user", 1),
				layer(map[string]any{}, "/project", 2),
			},
			want: map[string]any{"a": int64(1)},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := mergeLayers(testCase.layers, mergeOptions{arrayMerge: testCase.arrayMerge})
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("got %#v, want %#v", got, testCase.want)
			}
		})
	}
}

func TestMergeWarnsOnATypeConflict(t *testing.T) {
	var warnings []string
	got := mergeLayers(
		[]Layer{
			layer(map[string]any{"log": map[string]any{"level": "info"}}, "/user", 1),
			layer(map[string]any{"log": "debug"}, "/project", 2),
		},
		mergeOptions{warn: func(message string) { warnings = append(warnings, message) }},
	)
	if !reflect.DeepEqual(got, map[string]any{"log": "debug"}) {
		t.Fatalf("got %#v", got)
	}
	if len(warnings) != 1 {
		t.Fatalf("expected one warning, got %v", warnings)
	}
}

func TestMergeDoesNotAliasTheInputLayers(t *testing.T) {
	nested := map[string]any{"level": "info"}
	input := []Layer{layer(map[string]any{"log": nested}, "/user", 1)}

	result := mergeLayers(input, mergeOptions{})
	result["log"].(map[string]any)["level"] = "mutated"

	if nested["level"] != "info" {
		t.Fatalf("mutating the result changed the input layer: %v", nested)
	}
}

func TestApplyStrategy(t *testing.T) {
	defaults := layer(map[string]any{"d": int64(1)}, "", 0)
	user := layer(map[string]any{"log": map[string]any{"level": "info"}}, "/user", 1)
	project := layer(map[string]any{"log": map[string]any{"level": "debug"}}, "/project", 2)
	env := layer(map[string]any{"log": map[string]any{"level": "trace"}}, "", 4)

	if got := applyStrategy([]Layer{defaults, user, project, env}, "layered"); len(got) != 4 {
		t.Fatalf("layered dropped a layer: %v", got)
	}

	kept := applyStrategy([]Layer{defaults, user, project, env}, "first-match")
	// The user layer is gone entirely - not merged, and not reported. first-match means the
	// lower root was never consulted, not that it lost.
	if len(kept) != 3 || kept[1].Root != "/project" {
		t.Fatalf("first-match kept %v", kept)
	}
	want := map[string]any{"d": int64(1), "log": map[string]any{"level": "trace"}}
	if got := mergeLayers(kept, mergeOptions{}); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestApplyStrategyKeepsEveryFileOfTheWinningRoot(t *testing.T) {
	user := layer(map[string]any{"a": int64(1)}, "/user", 1)
	project := layer(map[string]any{"a": int64(2)}, "/project", 2)
	dotenv := Layer{
		Value:  map[string]any{"a": int64(3)},
		Root:   "/project",
		Source: Source{Path: "/project/.env", Format: "dotenv", Precedence: 3},
	}
	if got := applyStrategy([]Layer{user, project, dotenv}, "first-match"); len(got) != 2 {
		t.Fatalf("expected both files of the winning root, got %v", got)
	}
}
