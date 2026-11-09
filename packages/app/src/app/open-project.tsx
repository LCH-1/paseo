import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { OpenProjectScreen } from "@/screens/open-project-screen";
import { ProjectWindowBoundary } from "@/project-window/boundary";

export default function OpenProjectRoute() {
  return (
    <ProjectWindowBoundary>
      <HostRouteBootstrapBoundary>
        <OpenProjectScreen />
      </HostRouteBootstrapBoundary>
    </ProjectWindowBoundary>
  );
}
