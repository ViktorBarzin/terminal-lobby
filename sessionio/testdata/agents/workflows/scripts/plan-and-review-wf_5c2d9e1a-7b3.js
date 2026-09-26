export const meta = {
  name: 'plan-and-review',
  description: 'Plan the reviewers, run them side by side, then land what they pass',
  phases: [
    { title: 'Plan', detail: 'pick the reviewers' },
    { title: 'Review', detail: 'one agent per reviewer, in parallel' },
    { title: 'Land', detail: 'merge, push and watch CI' },
  ],
}

phase('Plan')
const plan = await agent('Pick the reviewers this change needs.', { label: 'plan' })

phase('Review')
const reviews = await parallel(plan.reviewers.map((r) => () => agent(`Review the change for ${r}.`, { label: `review:${r}` })))

phase('Land')
await agent('Merge what the reviewers passed and push it.', { label: 'land' })
