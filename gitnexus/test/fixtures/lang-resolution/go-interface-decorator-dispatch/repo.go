package decorator

// The decorator shape from #2836: loggingRepo implements Repository and holds
// its delegate in a Repository-typed field.
type Repository interface {
	DeleteItem(id string) error
	Count() int
}

type SqlRepo struct{ dsn string }

func (s *SqlRepo) DeleteItem(id string) error { return nil }

func (s *SqlRepo) Count() int { return 0 }

type loggingRepo struct{ next Repository }

func (l *loggingRepo) DeleteItem(id string) error {
	l.next.Count()
	return l.next.DeleteItem(id)
}

func (l *loggingRepo) Count() int { return l.next.Count() }

// Service is the control: a caller that is not itself an implementation keeps
// the whole fan-out.
type Service struct{ repo Repository }

func (s *Service) Run(id string) error { return s.repo.DeleteItem(id) }

// Node is the control for genuine same-implementation dispatch: a tree walk
// recurses through an interface-typed parameter or local, either of which can
// hold another node of the same type, so the edge back into the caller is a
// real target and is kept.
type Node interface {
	Walk(child Node) int
}

type leafNode struct{}

func (f *leafNode) Walk(child Node) int { return 1 }

type dirNode struct{}

func (d *dirNode) Walk(child Node) int { return child.Walk(nil) }

type linkNode struct{}

func (k *linkNode) Walk(child Node) int {
	var target Node = child
	return target.Walk(nil)
}
