import { ArtifactsPackage } from "@gent/extensions/artifacts-package.js"

export default ArtifactsPackage.tui((ctx) => ({
  borderLabels: [
    {
      position: "bottom-right" as const,
      priority: 50,
      produce: () => {
        const model = ctx.getSnapshot()
        if (!model?.items?.length) return []
        const currentBranch = ctx.branchId
        const active = model.items.filter(
          (a: { status: string; branchId?: string }) =>
            a.status === "active" && (a.branchId === undefined || a.branchId === currentBranch),
        ).length
        if (active === 0) return []
        return [
          {
            text: `${active} artifact${active !== 1 ? "s" : ""}`,
            color: "info" as const,
          },
        ]
      },
    },
  ],
}))
