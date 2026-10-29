package service

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

// userQuestions is the ask_user_question input, validated like the
// TypeScript host's schema.
type userQuestions struct {
	RequestID string         `json:"request_id"`
	Questions []userQuestion `json:"questions"`
}

type userQuestion struct {
	ID            string           `json:"id"`
	Header        string           `json:"header,omitempty"`
	Question      string           `json:"question"`
	Options       []questionOption `json:"options"`
	MultiSelect   bool             `json:"multiSelect"`
	AllowFreeText bool             `json:"allowFreeText"`
}

type questionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

var (
	questionID    = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)
	errBadAnswers = errors.New("answer every question in this request")
)

// parseUserQuestions validates ask_user_question arguments and applies the
// defaults: no options, single choice, free text allowed.
func parseUserQuestions(raw json.RawMessage) (userQuestions, error) {
	var in struct {
		RequestID string `json:"request_id"`
		Questions []struct {
			userQuestion
			MultiSelect   *bool `json:"multiSelect"`
			AllowFreeText *bool `json:"allowFreeText"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return userQuestions{}, errors.New("invalid question arguments")
	}
	if in.RequestID == "" || len(in.RequestID) > 128 || !questionID.MatchString(in.RequestID) {
		return userQuestions{}, errors.New("request_id must be 1-128 letters, digits, '_' or '-'")
	}
	if len(in.Questions) < 1 || len(in.Questions) > 4 {
		return userQuestions{}, errors.New("ask 1 to 4 questions")
	}
	out := userQuestions{RequestID: in.RequestID}
	ids := map[string]bool{}
	for _, q := range in.Questions {
		item := q.userQuestion
		item.Header, item.Question = strings.TrimSpace(item.Header), strings.TrimSpace(item.Question)
		item.MultiSelect = q.MultiSelect != nil && *q.MultiSelect
		item.AllowFreeText = q.AllowFreeText == nil || *q.AllowFreeText
		if item.ID == "" || len(item.ID) > 80 || !questionID.MatchString(item.ID) || ids[item.ID] {
			return userQuestions{}, errors.New("question IDs must be unique letters, digits, '_' or '-'")
		}
		ids[item.ID] = true
		if utf8.RuneCountInString(item.Header) > 40 || item.Question == "" || utf8.RuneCountInString(item.Question) > 4000 || len(item.Options) > 8 {
			return userQuestions{}, errors.New("invalid question")
		}
		labels := map[string]bool{}
		for i, o := range item.Options {
			o.Label = strings.TrimSpace(o.Label)
			if o.Label == "" || utf8.RuneCountInString(o.Label) > 200 || utf8.RuneCountInString(o.Description) > 1000 || labels[o.Label] {
				return userQuestions{}, errors.New("option labels must be unique and 1-200 characters")
			}
			labels[o.Label] = true
			item.Options[i] = o
		}
		if !item.AllowFreeText && len(item.Options) == 0 {
			return userQuestions{}, errors.New("fixed-choice questions need options")
		}
		if item.Options == nil {
			item.Options = []questionOption{}
		}
		out.Questions = append(out.Questions, item)
	}
	return out, nil
}

// questionAnswers validates answers against the questions: every question
// answered, one choice unless multi-select, and only offered choices unless
// free text is allowed.
func questionAnswers(qs userQuestions, raw json.RawMessage) (map[string]any, error) {
	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || len(values) != len(qs.Questions) {
		return nil, errBadAnswers
	}
	answers := map[string]any{}
	for _, q := range qs.Questions {
		value, ok := values[q.ID]
		if !ok {
			return nil, errBadAnswers
		}
		var selected []string
		var one string
		if json.Unmarshal(value, &one) == nil {
			selected = []string{one}
		} else if json.Unmarshal(value, &selected) != nil || len(selected) < 1 || len(selected) > 9 {
			return nil, errBadAnswers
		}
		for i, s := range selected {
			s = strings.TrimSpace(s)
			if s == "" || utf8.RuneCountInString(s) > 20000 {
				return nil, errBadAnswers
			}
			selected[i] = s
		}
		if !q.MultiSelect && len(selected) != 1 {
			return nil, errors.New("choose one answer for this question")
		}
		if !q.AllowFreeText {
			for _, s := range selected {
				offered := false
				for _, o := range q.Options {
					offered = offered || o.Label == s
				}
				if !offered {
					return nil, errors.New("choose one of the offered answers")
				}
			}
		}
		if q.MultiSelect {
			unique := []string{}
			seen := map[string]bool{}
			for _, s := range selected {
				if !seen[s] {
					seen[s] = true
					unique = append(unique, s)
				}
			}
			answers[q.ID] = unique
		} else {
			answers[q.ID] = selected[0]
		}
	}
	return answers, nil
}
