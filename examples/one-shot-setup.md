# Example: One-shot Web SDK setup

Real example of calling the `setup_target_websdk` orchestration tool.

## Input

```json
{
  "datastreamName": "Luma Production",
  "targetClientCode": "agsinternal",
  "propertyName": "Luma - Target Web SDK",
  "domains": ["luma.enablementadobe.com"],
  "pageNamePath": "digitalData.page.pageInfo.pageName",
  "crmIdPath": "digitalData.user[0].profile[0].profileInfo.profileID",
  "renderDecisions": true,
  "includeOrderRule": false,
  "runValidation": true
}
```

## Expected output

```json
{
  "status": "success",
  "progress": [
    "Created datastream 35da06eb-... (Luma Production)",
    "Added Target service to datastream",
    "Created property PR54... (Luma - Target Web SDK)",
    "Created host + dev/staging/prod environments",
    "Installed Web SDK extension EX31...",
    "Data elements: 10 ready (0 skipped)",
    "Rules: 1 ready (0 skipped)",
    "Built dev library LB5a... (succeeded in 29s)",
    "Validation: grade A, score 100"
  ],
  "datastream_id": "35da06eb-...",
  "property_id": "PR54cec5...",
  "environments": {
    "development": { "id": "EN11ff...", "embed_code": "<script src=\"https://assets.adobedtm.com/.../launch-...development.min.js\" async></script>" },
    "staging": { "id": "EN00ab...", "embed_code": "<script src=\"...\" async></script>" },
    "production": { "id": "EN80c1...", "embed_code": "<script src=\"...\" async></script>" }
  },
  "extensions": [
    { "name": "AEP Web SDK", "id": "EX31d4..." },
    { "name": "Core", "id": "EX578e..." }
  ],
  "data_elements_created": 10,
  "rules_created": 1,
  "library": { "id": "LB5a08...", "build_status": "succeeded" },
  "validation": { "grade": "A", "score": 100, "summary": "Implementation is working end-to-end." },
  "dev_embed_code": "<script src=\"https://assets.adobedtm.com/.../launch-...development.min.js\" async></script>",
  "next_steps": [
    "Add the dev_embed_code <script> tag to your website's <head>.",
    "Deploy actual Target activities in Target → Activities for the URLs you wired.",
    "Call check_website_implementation once the code is deployed to verify the script is loading.",
    "Call run_full_validation for final sign-off after the activity is live."
  ]
}
```

## What gets created

| Resource | Where | Notes |
|---|---|---|
| Datastream | AEP UI → Data Collection → Datastreams | Target service enabled |
| Tags property | AEP UI → Data Collection → Tags | All three environments |
| Web SDK extension | Inside the Tags property | Wired to the datastream's edgeConfigId |
| 10 data elements | Inside the Tags property | Page-Name, Page-URL, Page-Referrer, User-Auth-State, User-CRM-ID, XDM-Page-View, XDM-Identity-Map, Target-Profile-Attributes, Target-mbox3rdPartyId, Environment-Name |
| 1 rule | Inside the Tags property | "All Pages - Target WebSDK - Page Load" — DOM Ready + Send Event with renderDecisions:true |
| Dev library | Inside the Tags property | Auto-built and available at the dev embed URL |

## Including order-confirmation rule

For ecommerce sites, set `includeOrderRule: true` and `orderPagePath: "/order-confirmation"` (or your actual order path). This adds:

- `Order - ID`, `Order - Total`, `Order - Products` data elements
- An "Order Confirmation" rule that fires on the order page with a Send Event of type `commerce.purchases`

## Resuming after a failure

If a step fails, the orchestrator returns:

```json
{
  "status": "partial_failure",
  "failed_at_step": "install_websdk_extension",
  "failure_details": "Reactor API 403: ...",
  "progress": ["Created datastream ...", "Added Target service to datastream", ...]
}
```

Read `failure_details`, fix the root cause (usually a permission issue — see [troubleshooting.md](../docs/troubleshooting.md)), then re-run `setup_target_websdk` with the same input. The orchestrator detects existing resources (datastream, property, extension) and resumes from where it left off.
