const SKELETON_ROWS = 7

export function BootSkeleton() {
  return (
    <>
      <aside className="sidebar boot-sidebar" aria-hidden="true">
        <div className="boot-brand">
          <span className="boot-shimmer boot-glyph" />
          <span className="boot-shimmer boot-line boot-brand-line" />
        </div>
        <div className="boot-shimmer boot-search" />
        <div className="boot-rows">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div className="boot-row" key={index}>
              <span className="boot-shimmer boot-dot" />
              <span className="boot-row-lines">
                <span className="boot-shimmer boot-line" />
                <span className="boot-shimmer boot-line is-sub" />
              </span>
            </div>
          ))}
        </div>
      </aside>
      <main className="boot-main" aria-busy="true" aria-label="Loading Chat Hub">
        <div className="boot-canvas" />
        <div className="boot-composer">
          <span className="boot-shimmer boot-composer-field" />
          <span className="boot-shimmer boot-composer-send" />
        </div>
      </main>
    </>
  )
}
