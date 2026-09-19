import { formatTime } from './format'

type TimeTrendChartPoint = {
  treatmentId: string
  date: string
  procedureName: string
  actualDuration: number
  expectedDuration: number
}

type TimeTrendChartProps = {
  points: TimeTrendChartPoint[]
}

/*
  A small hand-rolled SVG line chart - no charting library, matching
  how the timer's progress ring is already plain SVG elsewhere in
  this app. Plots actual treatment duration over time (oldest to
  newest, left to right) with a dashed reference line for the
  average expected duration across the plotted points.
*/

function TimeTrendChart({ points }: TimeTrendChartProps) {

  if (points.length < 2) {
    return (
      <p className="empty-message">
        Complete more treatments to see a time trend.
      </p>
    )
  }

  const width = 640
  const height = 220
  const paddingLeft = 50
  const paddingRight = 20
  const paddingTop = 16
  const paddingBottom = 30

  const plotWidth = width - paddingLeft - paddingRight
  const plotHeight = height - paddingTop - paddingBottom

  const maxDuration =
    Math.max(
      ...points.map(point => point.actualDuration),
      ...points.map(point => point.expectedDuration)
    ) || 1

  const averageExpected =
    points.reduce((total, point) => total + point.expectedDuration, 0) /
    points.length

  function xFor(index: number) {
    return points.length === 1
      ? paddingLeft
      : paddingLeft +
          (index / (points.length - 1)) * plotWidth
  }

  function yFor(durationSeconds: number) {
    return (
      paddingTop +
      plotHeight -
      (durationSeconds / maxDuration) * plotHeight
    )
  }

  const linePath =
    points
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(point.actualDuration)}`
      )
      .join(' ')

  const referenceY = yFor(averageExpected)

  return (

    <div className="trend-chart">

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="trend-chart-svg"
      >

        <line
          className="trend-chart-axis"
          x1={paddingLeft}
          y1={paddingTop}
          x2={paddingLeft}
          y2={paddingTop + plotHeight}
        />

        <line
          className="trend-chart-axis"
          x1={paddingLeft}
          y1={paddingTop + plotHeight}
          x2={paddingLeft + plotWidth}
          y2={paddingTop + plotHeight}
        />

        <line
          className="trend-chart-reference"
          x1={paddingLeft}
          y1={referenceY}
          x2={paddingLeft + plotWidth}
          y2={referenceY}
        />

        <text
          className="trend-chart-label"
          x={paddingLeft - 8}
          y={paddingTop + 4}
          textAnchor="end"
        >
          {formatTime(maxDuration)}
        </text>

        <text
          className="trend-chart-label"
          x={paddingLeft - 8}
          y={paddingTop + plotHeight}
          textAnchor="end"
        >
          0:00
        </text>

        <path
          className="trend-chart-line"
          d={linePath}
          fill="none"
        />

        {points.map((point, index) => (

          <circle
            key={point.treatmentId}
            className="trend-chart-dot"
            cx={xFor(index)}
            cy={yFor(point.actualDuration)}
            r={4}
          >
            <title>
              {point.procedureName} — {formatTime(point.actualDuration)}
            </title>
          </circle>

        ))}

      </svg>

      <p className="trend-chart-caption">
        Dashed line = average expected duration ({formatTime(averageExpected)})
        across the {points.length} plotted treatments.
      </p>

    </div>

  )

}

export default TimeTrendChart
