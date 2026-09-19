import { TOOTH_CHART, type Tooth } from './teeth'

type ToothChartProps = {
  /*
    Single-select mode (New Treatment tooth picker): pass
    selectedToothId + onSelect.
  */
  selectedToothId?: string | null
  onSelect?: (toothId: string) => void
  /*
    Multi-select mode (Statistics comparison filter): pass
    selectedToothIds + onToggle instead. Tapping a tooth adds/removes
    it from the selection rather than replacing it.
  */
  selectedToothIds?: string[]
  onToggle?: (toothId: string) => void
}

/*
  Standard FDI dental-chart layout: patient's right appears on the
  viewer's left (as if looking into the patient's mouth), each arch
  reads from the midline outward on both sides, and the two rows
  mirror each other (upper-right sits directly above lower-right).
  Tooth width narrows from molar -> premolar -> anterior so the row
  reads as a recognizable arch rather than a flat list of numbers.
*/

function quadrant(arch: Tooth['arch'], side: Tooth['side'], order: 'inward' | 'outward') {

  const teeth =
    TOOTH_CHART.filter(
      tooth => tooth.arch === arch && tooth.side === side
    )

  teeth.sort((a, b) =>
    order === 'inward'
      ? b.position - a.position
      : a.position - b.position
  )

  return teeth

}

const UPPER_RIGHT = quadrant('upper', 'right', 'inward')
const UPPER_LEFT = quadrant('upper', 'left', 'outward')
const LOWER_RIGHT = quadrant('lower', 'right', 'inward')
const LOWER_LEFT = quadrant('lower', 'left', 'outward')

function ToothChart({
  selectedToothId,
  onSelect,
  selectedToothIds,
  onToggle,
}: ToothChartProps) {

  function isSelected(toothId: string) {
    return selectedToothIds
      ? selectedToothIds.includes(toothId)
      : selectedToothId === toothId
  }

  function handleClick(toothId: string) {
    if (onToggle) {
      onToggle(toothId)
    } else if (onSelect) {
      onSelect(toothId)
    }
  }

  function renderTooth(tooth: Tooth) {

    return (

      <button
        key={tooth.toothId}
        type="button"
        className={`tooth-button tooth-${tooth.region} ${
          isSelected(tooth.toothId) ? 'tooth-selected' : ''
        }`}
        onClick={() => handleClick(tooth.toothId)}
        title={`${tooth.displayName} (${tooth.toothId})`}
      >
        {tooth.position}
      </button>

    )

  }

  return (

    <div className="tooth-chart">

      <div className="tooth-chart-row tooth-chart-row-upper">

        <span className="tooth-chart-quadrant-label">
          Upper Right
        </span>

        <div className="tooth-chart-arch">
          {UPPER_RIGHT.map(renderTooth)}
          <span className="tooth-chart-midline" />
          {UPPER_LEFT.map(renderTooth)}
        </div>

        <span className="tooth-chart-quadrant-label">
          Upper Left
        </span>

      </div>

      <div className="tooth-chart-divider" />

      <div className="tooth-chart-row tooth-chart-row-lower">

        <span className="tooth-chart-quadrant-label">
          Lower Right
        </span>

        <div className="tooth-chart-arch">
          {LOWER_RIGHT.map(renderTooth)}
          <span className="tooth-chart-midline" />
          {LOWER_LEFT.map(renderTooth)}
        </div>

        <span className="tooth-chart-quadrant-label">
          Lower Left
        </span>

      </div>

    </div>

  )

}

export default ToothChart
