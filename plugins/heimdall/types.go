package main

// ModelInfo represents information about a model
type ModelInfo struct {
	Slug         string           `json:"slug"`
	Name         string           `json:"name"`
	Provider     string           `json:"provider"`
	Family       string           `json:"family"`
	CtxIn        int              `json:"ctx_in"`
	CtxOut       int              `json:"ctx_out"`
	Pricing      ModelPricing     `json:"pricing"`
	Capabilities ModelCapabilities `json:"capabilities"`
	QualityTier  string           `json:"quality_tier"`
}

// ModelCapabilities represents the capabilities of a model
type ModelCapabilities struct {
	Reasoning        bool `json:"reasoning"`
	Vision           bool `json:"vision"`
	FunctionCalling  bool `json:"function_calling"`
	StructuredOutput bool `json:"structured_output"`
	Multimodal       bool `json:"multimodal"`
	FineTuning       bool `json:"fine_tuning"`
}

// ModelPricing represents the pricing information for a model
type ModelPricing struct {
	InPerMillion  float64 `json:"in_per_million"`
	OutPerMillion float64 `json:"out_per_million"`
	Currency      string  `json:"currency"`
}