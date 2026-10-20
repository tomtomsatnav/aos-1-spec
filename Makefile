.PHONY: test validate serve
test: ## Run the conformance validator selftest
	node conformance/validate.mjs --selftest
validate: ## Validate ./state against the schemas and the spec MUSTs
	node conformance/validate.mjs
serve: ## Reference server on http://127.0.0.1:4317 (set AOS_UI_DIR to serve a UI)
	node server.mjs
