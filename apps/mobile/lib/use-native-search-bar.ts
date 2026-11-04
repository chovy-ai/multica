/**
 * Hook for wiring an iOS native `UISearchController` (via react-native-screens
 * `headerSearchBarOptions`) into a route. Returns the current query string.
 *
 * Used by every search-enabled picker route on mobile (issue/project/label/
 * lead). Pair with `useScrollToTopOnChange` in the body to reset the list
 * scroll position when the filter changes.
 *
 * Why this exists rather than inlining `setOptions` in every route:
 *   - Cancel button contract: `cancelSearch()` clears the native text but
 *     does NOT fire `onChangeText`, so the route MUST reset query state in
 *     `onCancelButtonPress`. Easy to forget when copy-pasted.
 *   - Sensible defaults (autoCapitalize: "none", hideWhenScrolling: false)
 *     match the standard iOS picker pattern; one place to revise.
 *
 * Requires the Stack.Screen to register `headerShown: true` + a `title` in
 * the layout. See `apps/mobile/app/(app)/[workspace]/_layout.tsx` for the
 * pattern.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useNavigation } from "expo-router";
import type { NativeSyntheticEvent, TextInputFocusEventData } from "react-native";
import type { SearchBarCommands } from "react-native-screens";

export function useNativeSearchBar(
  placeholder: string,
  options?: { autoFocus?: boolean; initialQuery?: string },
): string {
  const navigation = useNavigation();
  const [query, setQuery] = useState(options?.initialQuery ?? "");
  const searchBar = useRef<SearchBarCommands>(null);
  const initialized = useRef(false);
  const initialQuery = options?.initialQuery;
  const autoFocus = options?.autoFocus;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        ref: searchBar,
        placeholder,
        autoCapitalize: "none",
        hideWhenScrolling: false,
        // Opt-in: pickers whose primary action is typing (assignee, label,
        // project, lead) set this so the keyboard appears on mount. Apple
        // HIG cautions against auto-keyboard for browse-first lists; pass
        // `autoFocus: true` only when the picker is search-first.
        autoFocus,
        onFocus: () => {
          if (initialized.current) return;
          initialized.current = true;
          if (initialQuery) searchBar.current?.setText(initialQuery);
        },
        onChangeText: (e: NativeSyntheticEvent<TextInputFocusEventData>) =>
          setQuery(e.nativeEvent.text),
        onCancelButtonPress: () => { initialized.current = true; setQuery(""); },
      },
    });
  }, [navigation, placeholder, autoFocus, initialQuery]);

  return query;
}
