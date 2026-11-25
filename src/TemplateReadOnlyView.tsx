import BackButton from './BackButton'
import type { ProcedureTemplate, TemplatePhase } from './App'
import { templateViewSections } from './templateView'

/*
  READ-ONLY TEMPLATE VIEW

  What a built-in template shows while template editing is switched
  off: its phases and target durations, one list per case type.
  Nothing on this screen can be changed.
*/

function PhaseList({ phases }: { phases: TemplatePhase[] }) {

  return (

    <ol className="template-view-phases">

      {phases.map((phase, index) => (

        <li key={`${index}-${phase.name}`}>
          <span>{phase.name}</span>
          <span>{Math.round(phase.duration / 60)} min</span>
        </li>

      ))}

    </ol>

  )

}

function TemplateReadOnlyView({
  template,
  breadcrumb,
  onBack,
}: {
  template: ProcedureTemplate
  breadcrumb: string
  onBack: () => void
}) {

  const sections = templateViewSections(template)

  return (

    <div className="app">

      <div className="top-header">

        <BackButton onClick={onBack} />

        <div className="title-block">
          <h1>{template.name}</h1>
          <p className="template-breadcrumb">{breadcrumb}</p>
        </div>

      </div>

      <div className="procedure-page">

        <p className="template-meta">
          Built-in template - view only. The durations are placeholder
          targets; you can still edit the phases of each treatment.
        </p>

        {sections.map(section => (

          <div key={section.caseType}>

            <h2 className="settings-section-title">
              {section.caseType} ({section.totalMinutes} min)
            </h2>

            <PhaseList phases={section.phases} />

          </div>

        ))}

      </div>

    </div>

  )

}

export default TemplateReadOnlyView
